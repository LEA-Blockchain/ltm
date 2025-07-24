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

async function main() {
    console.log('[INFO] Starting automated tests...');

    // 1. Generate all necessary keys
    console.log('\n[STEP 1] Generating keysets...');
    runCommand(`lea-keygen new --outfile ${path.join(keysDir, 'registrar.keys.json')} --force`);
    runCommand(`lea-keygen new --outfile ${path.join(keysDir, 'deployer.keys.json')} --force`);
    runCommand(`lea-keygen new --outfile ${path.join(keysDir, 'treasuryAdmin.keys.json')} --force`);
    runCommand(`lea-keygen new --outfile ${path.join(keysDir, 'treasuryAuditor.keys.json')} --force`);
    console.log('[PASS] Keysets generated successfully.');

    // 2. Run package and verify for each test case
    for (const test of testCases) {
        console.log(`\n[STEP 2] Testing: ${test.name}`);
        
        const keyArgs = Object.entries(test.keys)
            .map(([signer, keyPath]) => `--${signer} ${keyPath}`)
            .join(' ');

        const packageCommand = `node dist/cli.mjs package ${test.manifest} ${keyArgs}`;
        runCommand(packageCommand);

        const verifyCommand = `node dist/cli.mjs verify transaction.bin ${test.manifest}`;
        runCommand(verifyCommand);
        
        console.log(`[PASS] Test case '${test.name}' passed.`);
    }

    // 3. Clean up generated transaction file
    runCommand('rm transaction.bin');

    console.log('\n[SUCCESS] All tests completed successfully!');
}

main();
