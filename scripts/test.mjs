import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { MsctpEncoder } from '../msctp/msctp.js';
import { encodePreSignaturePayload, appendSignatures } from '../src/core/transactionEncoder.mjs';
import { decodeTransaction } from '../src/core/transactionDecoder.mjs';

const examplesDir = 'examples';
const keysDir = path.join(examplesDir, 'keys');
const manifestsDir = path.join(examplesDir, 'manifests');

const testCases = [
    {
        name: 'Minimal Manifest',
        manifest: path.join(manifestsDir, 'minimal.json'),
        keys: {
            registrar: path.join(keysDir, 'registrar.keys.json')
        }
    },
    {
        name: 'Multi-Invocation Manifest',
        manifest: path.join(manifestsDir, 'multi_invocation.json'),
        keys: {
            deployer: path.join(keysDir, 'deployer.keys.json')
        }
    },
    {
        name: 'Multi-Signer Manifest',
        manifest: path.join(manifestsDir, 'multi_signer.json'),
        keys: {
            treasuryAdmin: path.join(keysDir, 'treasuryAdmin.keys.json'),
            treasuryAuditor: path.join(keysDir, 'treasuryAuditor.keys.json')
        }
    },
    {
        name: 'Pubkey Set (INLINE) Manifest',
        manifest: path.join(manifestsDir, 'pubset_test.json'),
        keys: {
            identityOwner: path.join(keysDir, 'identityOwner.keys.json')
        }
    }
];

function runCommand(command) {
    console.log(`[EXEC] ${command}`);
    try {
        execSync(command, { stdio: 'inherit' });
    } catch (error) {
        console.error(`\n[FAIL] Command failed: ${command}`);
        process.exit(1);
    }
}

function ensureTestKeys() {
    const availabilityCheck = spawnSync('lea', ['--help'], { stdio: 'ignore' });
    if (availabilityCheck.error && availabilityCheck.error.code === 'ENOENT') {
        console.warn('[WARN] The `lea` CLI was not found on PATH. Using existing test keysets.');
        return;
    }

    console.log('[INFO] Generating fresh test keysets with lea keygen...');
    const keyFiles = [
        path.join(keysDir, 'registrar.keys.json'),
        path.join(keysDir, 'deployer.keys.json'),
        path.join(keysDir, 'treasuryAdmin.keys.json'),
        path.join(keysDir, 'treasuryAuditor.keys.json'),
        path.join(keysDir, 'identityOwner.keys.json'),
    ];
    for (const file of keyFiles) {
        const result = spawnSync('lea', ['keygen', 'new', '--outfile', file, '--force'], { stdio: 'inherit' });
        if (result.error && result.error.code === 'ENOENT') {
            console.error('[FAIL] `lea` CLI disappeared from PATH during key generation.');
            process.exit(1);
        }
        if (result.status !== 0) {
            if (existsSync(file)) {
                console.warn(`[WARN] lea keygen exited with code ${result.status}, but '${file}' was created. Continuing.`);
                continue;
            }
            console.error(`[FAIL] lea keygen failed for '${file}' (code ${result.status}).`);
            process.exit(1);
        }
    }
}

function buffersEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function rebuildTransaction(decoded) {
    const encoder = new MsctpEncoder();
    const manifestForEncode = {
        sequence: decoded.sequence,
        gasLimit: decoded.gasLimit,
        gasPrice: decoded.gasPrice,
        addresses: decoded.addresses,
        invocations: decoded.invocations
    };
    encodePreSignaturePayload(encoder, manifestForEncode);
    appendSignatures(encoder, decoded.signatures.map(sig => ({
        ed25519: sig.ed25519,
        falcon512: sig.falcon512
    })));
    const payload = encoder.build();
    const rebuilt = new Uint8Array(decoded.pod.length + payload.length);
    rebuilt.set(decoded.pod, 0);
    rebuilt.set(payload, decoded.pod.length);
    return rebuilt;
}

async function main() {
    console.log('[INFO] Starting automated tests...');
    // 0. Generate new-format key files required by test cases
    ensureTestKeys();

    // 1. Run package and verify for each test case
    const generatedFiles = [];
    for (const test of testCases) {
        console.log(`\n[STEP 2] Testing: ${test.name}`);

        const keyArgs = Object.entries(test.keys)
            .map(([signer, keyPath]) => `--${signer} ${keyPath}`)
            .join(' ');

        const packageCommand = `node dist/cli.mjs package ${test.manifest} ${keyArgs}`;
        runCommand(packageCommand);

        const expectedOutfile = test.manifest.replace(/\.json$/, '.tx.bin');
        generatedFiles.push(expectedOutfile);

        const verifyCommand = `node dist/cli.mjs verify ${expectedOutfile} ${test.manifest}`;
        runCommand(verifyCommand);

        const txBytes = new Uint8Array(await readFile(expectedOutfile));
        const manifestSource = await readFile(test.manifest, 'utf-8');
        const manifestData = JSON.parse(manifestSource);
        const decoded = decodeTransaction(txBytes, { manifest: manifestData });
        const rebuilt = rebuildTransaction(decoded);
        if (!buffersEqual(rebuilt, txBytes)) {
            console.error(`[FAIL] Round-trip mismatch for '${test.name}'.`);
            process.exit(1);
        }
        console.log(`[PASS] Round-trip encode check for '${test.name}'.`);

        console.log(`[PASS] Test case '${test.name}' passed.`);
    }

    // 3. Clean up generated transaction files
    if (generatedFiles.length > 0) {
        runCommand(`rm ${generatedFiles.join(' ')}`);
    }

    console.log('\n[SUCCESS] All tests completed successfully!');
}

main();
