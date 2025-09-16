import { execSync } from 'child_process';
import path from 'path';

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
    console.log('[INFO] Generating fresh test keysets with lea-keygen...');
    const keyFiles = [
        path.join(keysDir, 'registrar.keys.json'),
        path.join(keysDir, 'deployer.keys.json'),
        path.join(keysDir, 'treasuryAdmin.keys.json'),
        path.join(keysDir, 'treasuryAuditor.keys.json'),
        path.join(keysDir, 'identityOwner.keys.json'),
    ];
    for (const file of keyFiles) {
        runCommand(`lea-keygen new --outfile ${file} --force`);
    }
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
        
        console.log(`[PASS] Test case '${test.name}' passed.`);
    }

    // 3. Clean up generated transaction files
    if (generatedFiles.length > 0) {
        runCommand(`rm ${generatedFiles.join(' ')}`);
    }

    console.log('\n[SUCCESS] All tests completed successfully!');
}

main();
