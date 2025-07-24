#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { createTransaction } from '../core/index.mjs';
import { verifyTransaction } from './verifier.mjs';
import path from 'path';

const KEYSET_REGEX = /"\$keyset\(([^)]+)\)"/;

function printHelp() {
    console.log(`
  Usage: lea-ltm <command> [options]

  Commands:
    package <manifest-path> [key-options]   Package a JSON manifest into a binary transaction.
                                            (This is the default command if none is provided)
    
    verify <transaction-path> [manifest-path] Verify and decode a binary transaction file.
                                              Optionally cross-reference with a manifest.

  Key Options for 'package':
    --<signerName> <path-to-key-file>       Provide the key file for a required signer.
    
  Example:
    lea-ltm package ./manifests/minimal.json --registrar ./keys/reg.json
    lea-ltm verify ./transaction.bin ./manifests/minimal.json
`);
}

async function packageManifest(args) {
    if (args.length === 0) {
        console.error('[ERROR] No manifest file provided for package command.');
        printHelp();
        process.exit(1);
    }

    const manifestPath = args[0];
    let manifest, signerKeys;

    try {
        const manifestContent = await readFile(manifestPath, 'utf-8');
        const keysetMatch = manifestContent.match(KEYSET_REGEX);

        if (keysetMatch) {
            const keysetPath = path.resolve(path.dirname(manifestPath), keysetMatch[1]);
            console.log(`[INFO] Loading entire keyset from ${keysetPath}`);
            signerKeys = JSON.parse(await readFile(keysetPath, 'utf-8'));
            const cleanManifestContent = manifestContent.replace(KEYSET_REGEX, 'null');
            manifest = JSON.parse(cleanManifestContent);
        } else {
            manifest = JSON.parse(manifestContent);
            signerKeys = {};
            
            const signersToLoad = manifest.signers && Array.isArray(manifest.signers)
                ? manifest.signers
                : (manifest.feePayer ? [manifest.feePayer] : []);

            if (signersToLoad.length > 0) {
                console.log('[INFO] Loading keys for required signers...');
                const keyArgs = {};
                for (let i = 1; i < args.length; i += 2) {
                    const key = args[i].startsWith('--') ? args[i].slice(2) : args[i];
                    keyArgs[key] = args[i + 1];
                }

                for (const signerName of signersToLoad) {
                    const keyPath = keyArgs[signerName];
                    if (!keyPath) {
                        console.error(`[ERROR] Missing key file path for signer: '${signerName}'.`);
                        console.error(`Please provide it using the --${signerName} <path> argument.`);
                        process.exit(1);
                    }
                    const resolvedPath = path.resolve(keyPath);
                    console.log(`  - Loading key for '${signerName}' from ${resolvedPath}`);
                    signerKeys[signerName] = JSON.parse(await readFile(resolvedPath, 'utf-8'));
                }
            } else {
                 console.error('[ERROR] No signers or feePayer found in the manifest. Cannot determine who should sign.');
                 process.exit(1);
            }
        }

        const finalTransaction = await createTransaction(manifest, signerKeys);
        const outputPath = 'transaction.bin';
        await writeFile(outputPath, finalTransaction);
        console.log(`\n[PASS] Transaction successfully created at ${outputPath}`);

    } catch (error) {
        console.error(`\n[FAIL] An error occurred during packaging: ${error.message}`);
        process.exit(1);
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }

    const command = args[0];
    const commandArgs = args.slice(1);

    switch (command) {
        case 'verify':
            await verifyTransaction(commandArgs[0], commandArgs[1]);
            break;
        case 'package':
            await packageManifest(commandArgs);
            break;
        default:
            await packageManifest(args);
            break;
    }
}

main();
