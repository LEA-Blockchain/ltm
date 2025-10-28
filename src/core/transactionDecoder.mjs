import {
    MsctpDecoder,
    MSCTP_TT_ULEB128,
    MSCTP_TT_SLEB128,
    MSCTP_TT_SMALL_VECTOR,
    MSCTP_TT_LARGE_VECTOR
} from '../../msctp/msctp.js';

function toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bigintToJson(value) {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) {
        return asNumber;
    }
    return value.toString();
}

function decodeInstructionVector(vectorBytes) {
    const decoder = new MsctpDecoder(vectorBytes);
    const instructions = [];
    let error = null;

    try {
        while (decoder.hasNext()) {
            const type = decoder.peekType();
            switch (type) {
                case MSCTP_TT_ULEB128: {
                    const value = decoder.readUleb128();
                    instructions.push({ uleb: bigintToJson(value) });
                    break;
                }
                case MSCTP_TT_SLEB128: {
                    const value = decoder.readSleb128();
                    instructions.push({ sleb: bigintToJson(value) });
                    break;
                }
                case MSCTP_TT_SMALL_VECTOR:
                case MSCTP_TT_LARGE_VECTOR: {
                    const payload = decoder.readVector();
                    instructions.push({ vector: toHex(payload) });
                    break;
                }
                default:
                    throw new Error(`Unsupported MSCTP instruction type: ${type}`);
            }
        }
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    }

    return {
        instructions: error ? null : instructions,
        rawHex: toHex(vectorBytes),
        error
    };
}

function toSafeIndex(bigintValue, fieldName) {
    const asNumber = Number(bigintValue);
    if (!Number.isSafeInteger(asNumber)) {
        throw new Error(`${fieldName} is outside of JavaScript safe integer range.`);
    }
    return asNumber;
}

/**
 * Decode a Lea transaction into its canonical manifest representation.
 * @param {Uint8Array} txBytes - The raw transaction bytes.
 * @param {object} [options]
 * @param {boolean} [options.stripVmHeader=false] - Remove the Lea VM wrapper (magic + length) before decoding.
 * @returns {object} - A canonical manifest-like object derived from the transaction.
 */
export function decodeTransaction(txBytes, options = {}) {
    if (!(txBytes instanceof Uint8Array)) {
        throw new TypeError('decodeTransaction expects a Uint8Array.');
    }

    const { stripVmHeader = false } = options;

    let workingBytes = txBytes;
    let vmHeader = null;

    if (stripVmHeader) {
        const HEADER_LENGTH = 13;
        if (workingBytes.length < HEADER_LENGTH) {
            throw new Error('VM-wrapped transaction is shorter than the expected 13-byte header.');
        }

        const MAGIC = [0x4c, 0x45, 0x41, 0x42]; // 'L', 'E', 'A', 'B'
        for (let i = 0; i < MAGIC.length; i++) {
            if (workingBytes[i] !== MAGIC[i]) {
                throw new Error(`Invalid VM magic header at position ${i}. Expected '${String.fromCharCode(MAGIC[i])}'.`);
            }
        }

        const vmVersion = workingBytes[4];
        if (vmVersion !== 0x01) {
            throw new Error(`Unsupported VM header version ${vmVersion}. Expected 0x01.`);
        }
        const lengthBytes = workingBytes.subarray(5, HEADER_LENGTH);
        let declaredLength = 0n;
        for (let i = 0; i < 8; i++) {
            declaredLength |= BigInt(lengthBytes[i]) << BigInt(8 * i);
        }

        if (declaredLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('VM length exceeds JavaScript safe integer range.');
        }

        const declaredLengthNumber = Number(declaredLength);
        const remaining = workingBytes.length - HEADER_LENGTH;
        if (declaredLengthNumber !== remaining) {
            throw new Error(`VM length field (${declaredLengthNumber}) does not match remaining bytes (${remaining}).`);
        }

        vmHeader = {
            magic: 'LEAB',
            version: vmVersion,
            length: declaredLengthNumber
        };
        workingBytes = workingBytes.subarray(HEADER_LENGTH);
    }

    if (workingBytes.length < 32) {
        throw new Error('Transaction is too short to contain a POD prefix.');
    }

    const pod = workingBytes.subarray(0, 32);
    const sctpPayload = workingBytes.subarray(32);
    const decoder = new MsctpDecoder(sctpPayload);

    const version = decoder.readUleb128();
    const sequence = decoder.readUleb128();

    const addressBytes = decoder.readVector();
    if (addressBytes.length % 32 !== 0) {
        throw new Error(`Addresses vector must be a multiple of 32 bytes. Found length ${addressBytes.length}.`);
    }
    const addresses = [];
    for (let offset = 0; offset < addressBytes.length; offset += 32) {
        addresses.push(toHex(addressBytes.subarray(offset, offset + 32)));
    }

    const gasLimit = decoder.readUleb128();
    const gasPrice = decoder.readUleb128();

    const invocations = [];
    while (decoder.hasNext()) {
        const nextType = decoder.peekType();
        if (nextType !== MSCTP_TT_ULEB128) {
            break;
        }
        const targetIndexBig = decoder.readUleb128();
        const instructionsVector = decoder.readVector();

        const targetIndex = toSafeIndex(targetIndexBig, 'Invocation target index');
        const instructionInfo = decodeInstructionVector(instructionsVector);
        const invocation = {
            targetIndex,
            targetAddressHex: addresses[targetIndex] ?? null,
            instructionsHex: instructionInfo.rawHex
        };
        if (instructionInfo.instructions) {
            invocation.instructions = instructionInfo.instructions;
        }
        if (instructionInfo.error) {
            invocation.decodeError = instructionInfo.error;
        }

        invocations.push(invocation);
    }

    const signatures = [];
    while (decoder.hasNext()) {
        const peek = decoder.peekType();
        if (peek !== MSCTP_TT_SMALL_VECTOR && peek !== MSCTP_TT_LARGE_VECTOR) {
            throw new Error(`Unexpected MSCTP type ${peek} while decoding signatures.`);
        }
        const ed25519 = decoder.readVector();
        if (!decoder.hasNext()) {
            throw new Error('Unpaired signature vector encountered (missing Falcon-512 component).');
        }
        const falcon512 = decoder.readVector();
        signatures.push({
            ed25519: toHex(ed25519),
            falcon512: toHex(falcon512)
        });
    }

    const result = {
        pod: toHex(pod),
        version: bigintToJson(version),
        sequence: bigintToJson(sequence),
        gasLimit: bigintToJson(gasLimit),
        gasPrice: bigintToJson(gasPrice),
        addresses,
        invocations,
        signatures
    };

    if (vmHeader) {
        result.vmHeader = vmHeader;
    }

    return result;
}
