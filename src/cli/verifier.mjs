import { readFile } from 'fs/promises';
import {
    MsctpDecoder,
    MSCTP_TT_ULEB128,
    MSCTP_TT_SLEB128,
    MSCTP_TT_SMALL_VECTOR,
    MSCTP_TT_LARGE_VECTOR
} from '../../msctp/msctp.js';

function decodeSCTPFields(buffer) {
    const decoder = new MsctpDecoder(buffer);
    const fields = [];
    try {
        while (decoder.hasNext()) {
            const type = decoder.peekType();
            let field;
            let value;
            if (type === MSCTP_TT_ULEB128) {
                value = decoder.readUleb128();
                field = `{T: ULEB128, V: ${value}n}`;
            } else if (type === MSCTP_TT_SLEB128) {
                value = decoder.readSleb128();
                field = `{T: SLEB128, V: ${value}n}`;
            } else if (type === MSCTP_TT_SMALL_VECTOR || type === MSCTP_TT_LARGE_VECTOR) {
                value = decoder.readVector();
                field = `{T:VECTOR, L: ${value.length}, V: ${Buffer.from(value).toString('hex')}}`;
            } else {
                field = `[ERROR: Unknown type ${type}]`;
                break;
            }
            fields.push(field);
        }
    } catch (e) {
        fields.push(`[ERROR: ${e.message}]`);
    }
    return fields.join(', ');
}

export async function verifyTransaction(txPath, manifestPath) {
    console.log(`[INFO] Verifying transaction file: '${txPath}'`);
    let manifest, txBytes;
    try {
        if (manifestPath) {
            manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
            console.log(`[INFO] Cross-referencing with manifest: '${manifestPath}'`);
        }
        const txBuffer = await readFile(txPath);
        txBytes = Uint8Array.from(txBuffer);
    } catch (e) {
        console.error(`[FAIL] Error reading files: ${e.message}`);
        return;
    }

    // The first 32 bytes are the POD (DecoderID)
    const pod = txBytes.subarray(0, 32);
    const sctpPayload = txBytes.subarray(32);

    console.log(`[INFO] POD (DecoderID): ${Buffer.from(pod).toString('hex')}`);

    const decoder = new MsctpDecoder(sctpPayload);
    const checks = { pass: 0, fail: 0 };
    const logCheck = (message, passed) => {
        console.log(`[${passed ? 'PASS' : 'FAIL'}] ${message}`);
        passed ? checks.pass++ : checks.fail++;
        return passed;
    };

    try {
        // 1. Version
        const version = decoder.readUleb128();
        logCheck(`Version is 1. Found: ${version}`, version === 1n);

        // 2. Sequence
        const sequence = decoder.readUleb128();
        if (manifest) {
            logCheck(`Sequence matches manifest (${manifest.sequence}). Found: ${sequence}`, sequence === BigInt(manifest.sequence));
        } else {
            console.log(`[INFO] Sequence: ${sequence}`);
        }

        // 3. Addresses
        const addressesField = decoder.readVector();
        const addressCount = addressesField.length / 32;
        const addressCheck = logCheck(`Addresses VECTOR length is a multiple of 32. Found: ${addressesField.length} bytes.`, addressesField.length % 32 === 0);
        
        const addressList = [];
        if(addressCheck) {
            console.log(`[INFO] Decoded ${addressCount} addresses:`);
            for (let i = 0; i < addressCount; i++) {
                const addressBytes = addressesField.subarray(i * 32, (i + 1) * 32);
                const address = Buffer.from(addressBytes).toString('hex');
                addressList.push(address);
                console.log(`    [${i}] ${address}`);
            }
        }

        // 4. Gas Limit
        const gasLimit = decoder.readUleb128();
        if (manifest) {
            logCheck(`Gas Limit matches manifest (${manifest.gasLimit}). Found: ${gasLimit}`, gasLimit === BigInt(manifest.gasLimit));
        } else {
            console.log(`[INFO] Gas Limit: ${gasLimit}`);
        }

        // 5. Gas Price
        const gasPrice = decoder.readUleb128();
        if (manifest) {
            logCheck(`Gas Price matches manifest (${manifest.gasPrice}). Found: ${gasPrice}`, gasPrice === BigInt(manifest.gasPrice));
        } else {
            console.log(`[INFO] Gas Price: ${gasPrice}`);
        }

        // 6. Invocations
        console.log('[INFO] Parsing Invocations...');
        const invocations = [];
        let manifestInvocationIndex = 0;
        while(decoder.hasNext() && decoder.peekType() === MSCTP_TT_ULEB128) {
            const targetIndex = decoder.readUleb128();
            const instructions = decoder.readVector();
            invocations.push({ targetIndex, instructions });
            
            const idx = Number(targetIndex);
            const targetAddress = addressList[idx] || 'INVALID_INDEX';

            console.log(`  [INFO] Invocation ${invocations.length - 1}:`);
            console.log(`    - Target Index: ${idx} -> Address: ${targetAddress}`);

            const manifestInstruction = manifest?.invocations[manifestInvocationIndex]?.instructions[0];
            if (manifestInstruction && Object.keys(manifestInstruction)[0] === 'INLINE') {
                console.log(`    - [WARN] Instructions contain an 'INLINE' directive. Skipping detailed cross-reference.`);
                console.log(`    - Raw Instructions (L=${instructions.length}): [ ${decodeSCTPFields(instructions)} ]`);
            } else {
                console.log(`    - Instructions (L=${instructions.length}): [ ${decodeSCTPFields(instructions)} ]`);
            }

            const validIndex = logCheck(`Invocation ${invocations.length-1} targetIndex is valid.`, idx < addressCount);
            if(!validIndex) throw new Error("Invalid targetIndex found.");
            manifestInvocationIndex++;
        }
        if (manifest) {
            logCheck(`Found ${invocations.length} invocations, matching manifest.`, invocations.length === manifest.invocations.length);
        }

        // 7. Signatures
        console.log('[INFO] Parsing Signatures...');
        const signatures = [];
        while(decoder.hasNext() && (decoder.peekType() === MSCTP_TT_SMALL_VECTOR || decoder.peekType() === MSCTP_TT_LARGE_VECTOR)) {
            const ed25519Signature = decoder.readVector();
            logCheck(`Ed25519 signature has correct length (64). Found: ${ed25519Signature.length}`, ed25519Signature.length === 64);
            const falcon512Signature = decoder.readVector();
            logCheck(`Falcon-512 signature is present (length > 0). Found: ${falcon512Signature.length}`, falcon512Signature.length > 0);
            signatures.push({ ed25519Signature, falcon512Signature });
        }
        logCheck(`Found ${signatures.length} signature pair(s).`, signatures.length > 0);
        
        logCheck('No trailing bytes after signatures.', !decoder.hasNext());

    } catch (e) {
        logCheck(`An exception occurred during parsing: ${e.message}`, false);
    } finally {
        console.log(`
Verification complete. Passed: ${checks.pass}, Failed: ${checks.fail}`);
    }
}
