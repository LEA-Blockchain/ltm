import { readFile } from 'fs/promises';

class SCTPDecoder {
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    readField(expectedType = null) {
        if (this.offset >= this.buffer.length) {
            throw new Error('Attempted to read past the end of the buffer.');
        }
        const header = this.buffer.readUInt8(this.offset);
        this.offset += 1;
        const typeId = header & 0x0F;
        const meta = header >> 4;

        const typeName = this.getTypeName(typeId);
        if (expectedType && typeName !== expectedType) {
            throw new Error(`Expected field type '${expectedType}' but found '${typeName}'.`);
        }

        switch (typeName) {
            case 'INT8': return { type: typeName, value: this.readInt8() };
            case 'UINT8': return { type: typeName, value: this.readUInt8() };
            case 'INT16': return { type: typeName, value: this.readInt16LE() };
            case 'UINT16': return { type: typeName, value: this.readUInt16LE() };
            case 'INT32': return { type: typeName, value: this.readInt32LE() };
            case 'UINT32': return { type: typeName, value: this.readUInt32LE() };
            case 'INT64': return { type: typeName, value: this.readBigInt64LE() };
            case 'UINT64': return { type: typeName, value: this.readBigUInt64LE() };
            case 'ULEB128': return { type: typeName, value: this.decodeULEB128() };
            case 'SLEB128': return { type: typeName, value: this.decodeSLEB128() };
            case 'FLOAT32': return { type: typeName, value: this.readFloatLE() };
            case 'FLOAT64': return { type: typeName, value: this.readDoubleLE() };
            case 'SHORT': return { type: typeName, value: meta };
            case 'VECTOR': return this.decodeVector(meta);
            case 'EOF': return { type: 'EOF' };
            default: throw new Error(`Reserved or unknown type ID: ${typeId}`);
        }
    }

    decodeVector(meta) {
        let length;
        if (meta === 15) {
            length = Number(this.decodeULEB128());
        } else {
            length = meta;
        }
        const value = this.readBytes(length);
        return { type: 'VECTOR', length, value };
    }

    decodeULEB128() {
        let result = 0n;
        let shift = 0n;
        while (true) {
            const byte = this.readUInt8();
            result |= (BigInt(byte & 0x7F) << shift);
            if ((byte & 0x80) === 0) break;
            shift += 7n;
        }
        return result;
    }
    
    getTypeName(typeId) {
        const types = ['INT8', 'UINT8', 'INT16', 'UINT16', 'INT32', 'UINT32', 'INT64', 'UINT64', 'ULEB128', 'SLEB128', 'FLOAT32', 'FLOAT64', 'SHORT', 'VECTOR', null, 'EOF'];
        return types[typeId];
    }

    // Buffer reading helpers
    readBytes(num) { this.checkRead(num); const s = this.buffer.slice(this.offset, this.offset + num); this.offset += num; return s; }
    checkRead(num) { if (this.offset + num > this.buffer.length) throw new Error('Unexpected end of stream.'); }
    readUInt8() { this.checkRead(1); const v = this.buffer.readUInt8(this.offset); this.offset += 1; return v; }
    readInt8() { this.checkRead(1); const v = this.buffer.readInt8(this.offset); this.offset += 1; return v; }
    readInt16LE() { this.checkRead(2); const v = this.buffer.readInt16LE(this.offset); this.offset += 2; return v; }
    readUInt16LE() { this.checkRead(2); const v = this.buffer.readUInt16LE(this.offset); this.offset += 2; return v; }
    readInt32LE() { this.checkRead(4); const v = this.buffer.readInt32LE(this.offset); this.offset += 4; return v; }
    readUInt32LE() { this.checkRead(4); const v = this.buffer.readUInt32LE(this.offset); this.offset += 4; return v; }
    readBigInt64LE() { this.checkRead(8); const v = this.buffer.readBigInt64LE(this.offset); this.offset += 8; return v; }
    readBigUInt64LE() { this.checkRead(8); const v = this.buffer.readBigUInt64LE(this.offset); this.offset += 8; return v; }
    readFloatLE() { this.checkRead(4); const v = this.buffer.readFloatLE(this.offset); this.offset += 4; return v; }
    readDoubleLE() { this.checkRead(8); const v = this.buffer.readDoubleLE(this.offset); this.offset += 8; return v; }
}

function decodeSCTPFields(buffer) {
    const decoder = new SCTPDecoder(buffer);
    const fields = [];
    try {
        while (decoder.offset < decoder.buffer.length) {
            const field = decoder.readField();
            let value = field.value;
            if (typeof value === 'bigint') {
                value = `${value}n`;
            } else if (Buffer.isBuffer(value)) {
                value = value.toString('hex');
            }
            if (field.type === 'VECTOR') {
                 fields.push(`{T: ${field.type}, L: ${field.length}, V: ${value}}`);
            } else {
                 fields.push(`{T: ${field.type}, V: ${value}}`);
            }
        }
    } catch (e) {
        fields.push(`[ERROR: ${e.message}]`);
    }
    return fields.join(', ');
}

export async function verifyTransaction(txPath, manifestPath) {
    console.log(`[INFO] Verifying transaction file: '${txPath}'`);
    let manifest, txBuffer;
    try {
        if (manifestPath) {
            manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
            console.log(`[INFO] Cross-referencing with manifest: '${manifestPath}'`);
        }
        txBuffer = await readFile(txPath);
    } catch (e) {
        console.error(`[FAIL] Error reading files: ${e.message}`);
        return;
    }

    const decoder = new SCTPDecoder(txBuffer);
    const checks = { pass: 0, fail: 0 };
    const logCheck = (message, passed) => {
        console.log(`[${passed ? 'PASS' : 'FAIL'}] ${message}`);
        passed ? checks.pass++ : checks.fail++;
        return passed;
    };

    try {
        // 1. Version
        const version = await decoder.readField('ULEB128');
        logCheck(`Version is 1. Found: ${version.value}`, version.value === 1n);

        // 2. Sequence
        const sequence = await decoder.readField('ULEB128');
        if (manifest) {
            logCheck(`Sequence matches manifest (${manifest.sequence}). Found: ${sequence.value}`, sequence.value === BigInt(manifest.sequence));
        } else {
            console.log(`[INFO] Sequence: ${sequence.value}`);
        }

        // 3. Addresses
        const addressesField = await decoder.readField('VECTOR');
        const addressCount = addressesField.length / 32;
        const addressCheck = logCheck(`Addresses VECTOR length is a multiple of 32. Found: ${addressesField.length} bytes.`, addressesField.length % 32 === 0);
        
        const addressList = [];
        if(addressCheck) {
            console.log(`[INFO] Decoded ${addressCount} addresses:`);
            for (let i = 0; i < addressCount; i++) {
                const address = addressesField.value.slice(i * 32, (i + 1) * 32).toString('hex');
                addressList.push(address);
                console.log(`    [${i}] ${address}`);
            }
        }

        // 4. Gas Limit
        const gasLimit = await decoder.readField('ULEB128');
        if (manifest) {
            logCheck(`Gas Limit matches manifest (${manifest.gasLimit}). Found: ${gasLimit.value}`, gasLimit.value === BigInt(manifest.gasLimit));
        } else {
            console.log(`[INFO] Gas Limit: ${gasLimit.value}`);
        }

        // 5. Gas Price
        const gasPrice = await decoder.readField('ULEB128');
        if (manifest) {
            logCheck(`Gas Price matches manifest (${manifest.gasPrice}). Found: ${gasPrice.value}`, gasPrice.value === BigInt(manifest.gasPrice));
        } else {
            console.log(`[INFO] Gas Price: ${gasPrice.value}`);
        }

        // 6. Invocations
        console.log('[INFO] Parsing Invocations...');
        const invocations = [];
        while(decoder.getTypeName(decoder.buffer[decoder.offset] & 0x0F) === 'ULEB128') {
            const targetIndex = await decoder.readField('ULEB128');
            const instructions = await decoder.readField('VECTOR');
            invocations.push({ targetIndex, instructions });
            
            const idx = Number(targetIndex.value);
            const targetAddress = addressList[idx] || 'INVALID_INDEX';

            console.log(`  [INFO] Invocation ${invocations.length - 1}:`);
            console.log(`    - Target Index: ${idx} -> Address: ${targetAddress}`);
            console.log(`    - Instructions (L=${instructions.length}): [ ${decodeSCTPFields(instructions.value)} ]`);

            const validIndex = logCheck(`Invocation ${invocations.length-1} targetIndex is valid.`, idx < addressCount);
            if(!validIndex) throw new Error("Invalid targetIndex found.");
        }
        if (manifest) {
            logCheck(`Found ${invocations.length} invocations, matching manifest.`, invocations.length === manifest.invocations.length);
        }

        // 7. Signatures
        console.log('[INFO] Parsing Signatures...');
        const signatures = [];
        while(decoder.getTypeName(decoder.buffer[decoder.offset] & 0x0F) === 'VECTOR') {
            const ed25519Signature = await decoder.readField('VECTOR');
            logCheck(`Ed25519 signature has correct length (64). Found: ${ed25519Signature.length}`, ed25519Signature.length === 64);
            const falcon512Signature = await decoder.readField('VECTOR');
            logCheck(`Falcon-512 signature is present (length > 0). Found: ${falcon512Signature.length}`, falcon512Signature.length > 0);
            signatures.push({ ed25519Signature, falcon512Signature });
        }
        logCheck(`Found ${signatures.length} signature pair(s).`, signatures.length > 0);
        
        // 8. EOF
        const eof = await decoder.readField('EOF');
        logCheck('Transaction ends with EOF marker.', eof.type === 'EOF');
        logCheck('No trailing bytes after EOF.', decoder.offset === txBuffer.length);

    } catch (e) {
        logCheck(`An exception occurred during parsing: ${e.message}`, false);
    } finally {
        console.log(`\nVerification complete. Passed: ${checks.pass}, Failed: ${checks.fail}`);
    }
}
