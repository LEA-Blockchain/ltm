import {
    MsctpDecoder,
    MSCTP_TT_ULEB128,
    MSCTP_TT_SLEB128,
    MSCTP_TT_SMALL_VECTOR,
    MSCTP_TT_LARGE_VECTOR
} from '../../msctp/msctp.js';
import { encode as encodeBech32m } from './bech32m.mjs';
import { ADDRESS_HRP } from './config.mjs';
import { createBLAKE3 } from 'hash-wasm';

const BYTE_META = Symbol('ltm.byteMeta');
const PUBSET_REGEX = /^\$pubset\(([^)]+)\)$/;

function toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function lebToJson(value) {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) {
        return asNumber;
    }
    return value.toString();
}

function bigintToJson(value) {
    return lebToJson(value);
}

function copyBytes(source) {
    const out = new Uint8Array(source.length);
    out.set(source);
    return out;
}

function decorateBytes(bytes, metadata = {}) {
    if (!(bytes instanceof Uint8Array)) {
        return bytes;
    }

    let store = bytes[BYTE_META];
    if (!store) {
        store = { cache: {}, meta: {} };
        Object.defineProperty(bytes, BYTE_META, {
            value: store,
            enumerable: false,
            configurable: false,
            writable: false
        });
        Object.defineProperties(bytes, {
            hex: {
                enumerable: false,
                configurable: false,
                get() {
                    const bucket = this[BYTE_META];
                    if (!bucket.cache.hex) {
                        bucket.cache.hex = toHex(this);
                    }
                    return bucket.cache.hex;
                }
            },
            bech32m: {
                enumerable: false,
                configurable: false,
                get() {
                    const bucket = this[BYTE_META];
                    const hrp = bucket.meta.bech32mHrp;
                    if (!hrp) {
                        return undefined;
                    }
                    if (!bucket.cache.bech32m) {
                        bucket.cache.bech32m = encodeBech32m(hrp, this);
                    }
                    return bucket.cache.bech32m;
                }
            },
            info: {
                enumerable: false,
                configurable: false,
                get() {
                    const bucket = this[BYTE_META];
                    return bucket.meta;
                }
            }
        });
    }

    Object.assign(store.meta, metadata);
    return bytes;
}

function extractInstructionLayout(manifest) {
    if (!manifest || !Array.isArray(manifest.invocations)) {
        return null;
    }
    return manifest.invocations.map(invocation => {
        const instructions = Array.isArray(invocation.instructions) ? invocation.instructions : [];
        return instructions.map(instr => {
            if (!instr || typeof instr !== 'object') {
                return { key: null, value: undefined, comment: undefined };
            }
            const keys = Object.keys(instr).filter(k => k !== 'comment');
            const key = keys[0] ?? null;
            return {
                key,
                value: key ? instr[key] : undefined,
                comment: typeof instr.comment === 'string' ? instr.comment : undefined
            };
        });
    });
}

function normaliseInstructionKey(layoutEntry) {
    if (!layoutEntry || typeof layoutEntry.key !== 'string') {
        return null;
    }
    const upper = layoutEntry.key.toUpperCase();
    if (upper === 'INLINE') return 'INLINE';
    if (upper === 'ULEB' || upper === 'ULEB128') return 'ULEB';
    if (upper === 'SLEB' || upper === 'SLEB128') return 'SLEB';
    if (upper === 'VECTOR') return 'VECTOR';
    return null;
}

function tryDecodePubset(decoder) {
    const start = decoder.offset;
    try {
        const firstMarker = decoder.readUleb128();
        const edPk = decoder.readVector();
        const secondMarker = decoder.readUleb128();
        const falconPk = decoder.readVector();

        if (firstMarker !== 0n || secondMarker !== 1n) {
            throw new Error('Unexpected pubset markers');
        }

        const end = decoder.offset;
        const raw = copyBytes(decoder.data.subarray(start, end));
        const edPkCopy = decorateBytes(copyBytes(edPk), { algorithm: 'ed25519', role: 'public' });
        const falPkCopy = decorateBytes(copyBytes(falconPk), { algorithm: 'falcon512', role: 'public' });
        const edSkStub = decorateBytes(new Uint8Array(0), { algorithm: 'ed25519', role: 'secret' });
        const falSkStub = decorateBytes(new Uint8Array(0), { algorithm: 'falcon512', role: 'secret' });
        return {
            raw,
            metadata: {
                kind: 'pubset',
                keys: {
                    ed25519: { sk: edSkStub, pk: edPkCopy },
                    falcon512: { sk: falSkStub, pk: falPkCopy }
                }
            }
        };
    } catch (err) {
        decoder.offset = start;
        return null;
    }
}

function decodeInline(decoder, layoutEntry) {
    const layoutValue = layoutEntry?.value;
    if (typeof layoutValue === 'string') {
        const pubsetMatch = layoutValue.match(PUBSET_REGEX);
        if (pubsetMatch) {
        const decoded = tryDecodePubset(decoder);
        if (decoded) {
            const inlineBytes = decorateBytes(decoded.raw, {
                kind: decoded.metadata.kind,
                signer: pubsetMatch[1],
                keys: decoded.metadata.keys,
                source: layoutValue
            });
            const edSk = decorateBytes(new Uint8Array(0), { algorithm: 'ed25519', role: 'secret' });
            const falSk = decorateBytes(new Uint8Array(0), { algorithm: 'falcon512', role: 'secret' });
            inlineBytes.info.keyset = [
                [edSk, decoded.metadata.keys.ed25519.pk],
                [falSk, decoded.metadata.keys.falcon512.pk]
            ];
            return inlineBytes;
        }
    }
    }

    const remaining = decoder.data.subarray(decoder.offset);
    const copy = copyBytes(remaining);
    decoder.offset = decoder.data.length;
    const metadata = typeof layoutValue === 'string'
        ? { kind: 'inline', source: layoutValue }
        : { kind: 'inline' };
    return decorateBytes(copy, metadata);
}

function decodeInstructions(vectorBytes, layoutEntries = []) {
    const decoder = new MsctpDecoder(vectorBytes);
    const instructions = [];
    let index = 0;

    while (decoder.hasNext()) {
        const layoutEntry = layoutEntries[index];
        const key = normaliseInstructionKey(layoutEntry);
        const comment = layoutEntry?.comment;
        let instruction;

        if (key === 'INLINE') {
            const inlineBytes = decodeInline(decoder, layoutEntry);
            instruction = { INLINE: inlineBytes };
        } else if (key === 'ULEB') {
            const value = lebToJson(decoder.readUleb128());
            instruction = { uleb: value };
        } else if (key === 'SLEB') {
            const value = lebToJson(decoder.readSleb128());
            instruction = { sleb: value };
        } else if (key === 'VECTOR') {
            const payload = decorateBytes(copyBytes(decoder.readVector()), { kind: 'vector' });
            instruction = { vector: payload };
        } else {
            const type = decoder.peekType();
            switch (type) {
                case MSCTP_TT_ULEB128: {
                    const value = lebToJson(decoder.readUleb128());
                    instruction = { uleb: value };
                    break;
                }
                case MSCTP_TT_SLEB128: {
                    const value = lebToJson(decoder.readSleb128());
                    instruction = { sleb: value };
                    break;
                }
                case MSCTP_TT_SMALL_VECTOR:
                case MSCTP_TT_LARGE_VECTOR: {
                    const payload = decorateBytes(copyBytes(decoder.readVector()), { kind: 'vector' });
                    instruction = { vector: payload };
                    break;
                }
                default:
                    throw new Error(`Unsupported MSCTP instruction type ${type}.`);
            }
        }

        if (comment) {
            instruction.comment = comment;
        }
        instructions.push(instruction);
        index++;
    }

    return instructions;
}

function toSafeIndex(bigintValue, fieldName) {
    const asNumber = Number(bigintValue);
    if (!Number.isSafeInteger(asNumber)) {
        throw new Error(`${fieldName} is outside of JavaScript safe integer range.`);
    }
    return asNumber;
}

function normalizeOptions(options) {
    const normalized = {
        stripVmHeader: false,
        manifest: null
    };

    if (!options || typeof options !== 'object') {
        return normalized;
    }

    const hasExplicitKeys =
        Object.prototype.hasOwnProperty.call(options, 'stripVmHeader') ||
        Object.prototype.hasOwnProperty.call(options, 'manifest');

    if (hasExplicitKeys) {
        normalized.stripVmHeader = Boolean(options.stripVmHeader);
        normalized.manifest = options.manifest ?? null;
        return normalized;
    }

    const looksLikeManifest =
        Array.isArray(options.invocations) ||
        typeof options.constants === 'object' ||
        (options.signers && typeof options.signers === 'object') ||
        typeof options.feePayer === 'string' ||
        options.sequence !== undefined;

    if (looksLikeManifest) {
        normalized.manifest = options;
    }

    return normalized;
}

/**
 * Decode a Lea transaction into a manifest-ready representation.
 * @param {Uint8Array} txBytes - The raw transaction bytes.
 * @param {object} [options] - Decoder options or the manifest itself (deprecated shorthand).
 * @param {boolean} [options.stripVmHeader=false] - Remove the Lea VM wrapper (magic + length) before decoding.
 * @param {object} [options.manifest] - Original manifest to guide instruction decoding.
 * @returns {object} - A manifest-like object derived from the transaction.
 */
export function decodeTransaction(txBytes, options = {}) {
    if (!(txBytes instanceof Uint8Array)) {
        throw new TypeError('decodeTransaction expects a Uint8Array.');
    }

    const { stripVmHeader, manifest } = normalizeOptions(options);

    let workingBytes = txBytes;
    let vmHeader = null;

    if (stripVmHeader) {
        const HEADER_LENGTH = 13;
        if (workingBytes.length < HEADER_LENGTH) {
            throw new Error('VM-wrapped transaction is shorter than the expected 13-byte header.');
        }

        const MAGIC = [0x4c, 0x45, 0x41, 0x42];
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

    const pod = decorateBytes(copyBytes(workingBytes.subarray(0, 32)), { role: 'pod' });
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
        const slice = copyBytes(addressBytes.subarray(offset, offset + 32));
        const index = addresses.length;
        addresses.push(decorateBytes(slice, { bech32mHrp: ADDRESS_HRP, index }));
    }

    const gasLimit = decoder.readUleb128();
    const gasPrice = decoder.readUleb128();

    const instructionLayouts = extractInstructionLayout(manifest);
    const invocations = [];
    let signatureStartOffset = -1;
    let invocationIndex = 0;

    while (decoder.hasNext()) {
        const nextType = decoder.peekType();
        if (nextType !== MSCTP_TT_ULEB128) {
            break;
        }
        const targetIndexBig = decoder.readUleb128();
        const instructionsVector = decoder.readVector();

        const targetIndex = toSafeIndex(targetIndexBig, 'Invocation target index');
        const layoutEntries = instructionLayouts ? instructionLayouts[invocationIndex] : undefined;
        const instructions = decodeInstructions(copyBytes(instructionsVector), layoutEntries);
        invocations.push({
            targetAddress: targetIndex,
            instructions
        });
        invocationIndex++;
    }

    signatureStartOffset = decoder.offset;
    const signatures = [];
    while (decoder.hasNext()) {
        const peek = decoder.peekType();
        if (peek !== MSCTP_TT_SMALL_VECTOR && peek !== MSCTP_TT_LARGE_VECTOR) {
            throw new Error(`Unexpected MSCTP type ${peek} while decoding signatures.`);
        }
        const ed25519 = decorateBytes(copyBytes(decoder.readVector()), { algorithm: 'ed25519' });
        if (!decoder.hasNext()) {
            throw new Error('Unpaired signature vector encountered (missing Falcon-512 component).');
        }
        const falcon512 = decorateBytes(copyBytes(decoder.readVector()), { algorithm: 'falcon512' });
        signatures.push({
            ed25519,
            falcon512
        });
    }

    const result = {
        pod,
        version: lebToJson(version),
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

    const preSignatureBytes = copyBytes(sctpPayload.subarray(0, signatureStartOffset >= 0 ? signatureStartOffset : sctpPayload.length));
    const signatureBytes = signatureStartOffset >= 0 ? copyBytes(sctpPayload.subarray(signatureStartOffset)) : new Uint8Array(0);

    Object.defineProperty(result, 'hashes', {
        enumerable: false,
        configurable: false,
        value: {
            async base() {
                const blake3 = await createBLAKE3();
                blake3.init();
                blake3.update(pod);
                blake3.update(preSignatureBytes);
                return blake3.digest('binary');
            },
            async baseHex() {
                const bytes = await this.base();
                return toHex(bytes);
            },
            preSignature: preSignatureBytes,
            signatureSection: signatureBytes
        }
    });

    return result;
}
