import { Encoder } from '@leachain/sctp';
import { ENCODER_INIT_SIZE } from './config.mjs';

const checkType = (val, type) => {
    if (typeof val !== type) throw new Error(`Invalid type: expected ${type}, got ${typeof val}`);
};
const checkInt = (val) => {
    checkType(val, 'number');
    if (!Number.isInteger(val)) throw new Error(`Invalid type: expected integer, got float for value ${val}`);
};

const checkRange = (val, min, max) => {
    if (val < min || val > max) throw new Error(`Value ${val} out of range (min: ${min}, max: ${max})`);
};

const checkBigInt = (val) => {
    try {
        return BigInt(val);
    } catch (e) {
        throw new Error(`Cannot convert value '${val}' to BigInt.`);
    }
};

const hexToBytes = (hex) => {
    if (typeof hex !== 'string') {
        throw new Error('Input must be a string');
    }
    if (hex.length % 2 !== 0) {
        throw new Error('Hex string must have an even number of characters');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
};

async function encodeInstructions(instructions) {
    const instructionEncoder = new Encoder();
    await instructionEncoder.init(ENCODER_INIT_SIZE);

    for (const instruction of instructions) {
        const key = Object.keys(instruction)[0];
        const value = instruction[key];

        switch (key) {
            case 'int8':
                checkInt(value);
                checkRange(value, -128, 127);
                instructionEncoder.addInt8(value);
                break;
            case 'uint8':
                checkInt(value);
                checkRange(value, 0, 255);
                instructionEncoder.addUint8(value);
                break;
            case 'int16':
                checkInt(value);
                checkRange(value, -32768, 32767);
                instructionEncoder.addInt16(value);
                break;
            case 'uint16':
                checkInt(value);
                checkRange(value, 0, 65535);
                instructionEncoder.addUint16(value);
                break;
            case 'int32':
                checkInt(value);
                checkRange(value, -2147483648, 2147483647);
                instructionEncoder.addInt32(value);
                break;
            case 'uint32':
                checkInt(value);
                checkRange(value, 0, 4294967295);
                instructionEncoder.addUint32(value);
                break;
            case 'int64':
                instructionEncoder.addInt64(checkBigInt(value));
                break;
            case 'uint64':
                instructionEncoder.addUint64(checkBigInt(value));
                break;
            case 'float32':
                checkType(value, 'number');
                instructionEncoder.addFloat32(value);
                break;
            case 'float64':
                checkType(value, 'number');
                instructionEncoder.addFloat64(value);
                break;
            case 'short':
                checkInt(value);
                checkRange(value, 0, 15);
                instructionEncoder.addShort(value);
                break;
            case 'vector':
                if (typeof value === 'string') {
                    instructionEncoder.addVector(hexToBytes(value));
                } else if (value instanceof Uint8Array) {
                    instructionEncoder.addVector(value);
                } else {
                    throw new Error(`Invalid type for 'vector': expected Uint8Array or hex string, got ${Object.prototype.toString.call(value)}`);
                }
                break;
            case 'uleb':
            case 'uleb128':
                instructionEncoder.addUleb128(checkBigInt(value));
                break;
            case 'sleb':
            case 'sleb128':
                instructionEncoder.addSleb128(checkBigInt(value));
                break;
            default:
                throw new Error(`Unsupported instruction type: ${key}`);
        }
    }
    return instructionEncoder.getBytes();
}


export async function encodePreSignaturePayload(encoder, resolvedManifest, finalAddressList) {
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
        // targetAddress is now the index
        encoder.addUleb128(BigInt(invocation.targetAddress)); 
        const instructionsBytes = await encodeInstructions(invocation.instructions);
        encoder.addVector(instructionsBytes);
    }
}

export function appendSignatures(encoder, signatures) {
    for (const sig of signatures) {
        encoder.addVector(sig.ed25519);
        encoder.addVector(sig.falcon512);
    }
}