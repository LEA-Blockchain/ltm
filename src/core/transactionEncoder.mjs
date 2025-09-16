import { MsctpEncoder } from '../../msctp/msctp.js';

// --- Type and Range Checkers ---
const checkBigInt = (val) => {
    try {
        return BigInt(val);
    } catch (e) {
        throw new Error(`Cannot convert value '${val}' to BigInt.`);
    }
};
const hexToBytes = (hex) => {
    if (typeof hex !== 'string') throw new Error('Input must be a string');
    if (hex.length % 2 !== 0) throw new Error('Hex string must have an even number of characters');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
};

// --- Instruction Encoder ---
function encodeInstructions(instructions) {
    const instructionEncoder = new MsctpEncoder();

    for (const instruction of instructions) {
        const keys = Object.keys(instruction).filter(k => k !== 'comment');
        if (keys.length !== 1) throw new Error(`Each instruction must have exactly one operational key. Found: ${keys.join(', ')}`);
        const key = keys[0];
        const value = instruction[key];

        switch (key) {
            case 'vector':
                if (typeof value === 'string') instructionEncoder.addVector(hexToBytes(value));
                else if (value instanceof Uint8Array) instructionEncoder.addVector(value);
                else throw new Error(`Invalid type for 'vector': expected Uint8Array or hex string`);
                break;
            case 'uleb': case 'uleb128': instructionEncoder.addUleb128(checkBigInt(value)); break;
            case 'sleb': case 'sleb128': instructionEncoder.addSleb128(checkBigInt(value)); break;
            case 'INLINE':
                if (!(value instanceof Uint8Array)) throw new Error(`Invalid type for 'INLINE': expected Uint8Array`);
                // MSCTP doesn't have a raw add, so we just push the chunk.
                // This is a bit of a hack, but it's the only way to support INLINE.
                instructionEncoder.chunks.push(value);
                break;
            default: throw new Error(`Unsupported instruction type: ${key}. MSCTP only supports uleb128, sleb128, vector, and INLINE.`);
        }
    }
    return instructionEncoder.build();
}

// --- EXPORTED HELPERS ---

/**
 * Encodes the pre-signature fields of a transaction into a given MSCTP encoder instance.
 * @param {MsctpEncoder} encoder - The MSCTP encoder instance to use.
 * @param {object} resolvedManifest - The fully resolved manifest object.
 */
export function encodePreSignaturePayload(encoder, resolvedManifest) {
    const finalAddressList = resolvedManifest.addresses;

    // 1. Version
    encoder.addUleb128(1n);

    // 2. Sequence
    encoder.addUleb128(BigInt(resolvedManifest.sequence));

    // 3. Addresses
    const addressVector = new Uint8Array(finalAddressList.reduce((acc, val) => acc + val.length, 0));
    let offset = 0;
    for (const addr of finalAddressList) {
        addressVector.set(addr, offset);
        offset += addr.length;
    }
    encoder.addVector(addressVector);

    // 4. Gas Limit & Price
    encoder.addUleb128(BigInt(resolvedManifest.gasLimit));
    encoder.addUleb128(BigInt(resolvedManifest.gasPrice));

    // 5. Invocations
    for (const invocation of resolvedManifest.invocations) {
        encoder.addUleb128(BigInt(invocation.targetAddress));
        const instructionsBytes = encodeInstructions(invocation.instructions);
        encoder.addVector(instructionsBytes);
    }
}

/**
 * Appends signature pairs to a given MSCTP encoder instance.
 * @param {MsctpEncoder} encoder - The MSCTP encoder instance to use.
 * @param {Array<object>} signatures - An array of signature pairs { ed25519, falcon512 }.
 */
export function appendSignatures(encoder, signatures) {
    for (const sig of signatures) {
        encoder.addVector(sig.ed25519);
        encoder.addVector(sig.falcon512);
    }
}
