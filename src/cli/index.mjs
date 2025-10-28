#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { createTransaction, decodeTransaction } from '../core/index.mjs';
import { PkmiCryptoHandler } from '../core/pkmiCryptoHandler.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyTransaction } from './verifier.mjs';
import { decodeExecutionResult } from '../core/resultDecoder.mjs';
import path from 'path';

const KEYSET_REGEX = /"\$keyset\(([^)]+)\)"/;
const FILE_VAR_REGEX = /^\$([a-zA-Z0-9_]+)$/;

function printHelp() {
    console.log(`
  Usage: lea-ltm <command> [options]

  Commands:
    package <manifest-path> [options]       Package a JSON manifest into a binary transaction.
                                            (This is the default command if none is provided)
    
    verify <transaction-path> [manifest-path] Verify and decode a binary transaction file.
                                              Optionally cross-reference with a manifest.
    decode <transaction-path> [--manifest <path>] [--outfile <path>]
                                             Decode a transaction into a canonical
                                             manifest-style JSON representation.
                                             Use --manifest to guide inline decoding
                                             and --strip-vm-header if the file
                                             includes the Lea VM wrapper.

    decode-result <result-path> <manifest-path> Decodes a binary execution result using a
                                                schema from the manifest.

  Options for 'package':
    --<signerName> <path-to-key-file>       Provide the key file for a required signer.
    --file <var> <path-to-file>             Load a file as binary data and assign it to a '$var'
                                            placeholder in the manifest.
    --outfile <path>                        Specify the output file path.
                                            (Defaults to the manifest name with a
                                            '.tx.bin' extension)
    --no-chain                              Disable chaining (skip fetching previous tx hash).

  Example:
    lea-ltm package ./m.json --sender ./s.json --file c ./c.wasm --outfile tx.bin
    lea-ltm verify ./tx.bin
    lea-ltm decode ./vm-wrapped.tx.bin --strip-vm-header
    lea-ltm decode-result ./result.bin ./m.json
`);
}

async function injectFileVariables(manifest, fileVars) {
    const loadedFiles = {};

    async function recursiveInject(obj) {
        for (const key in obj) {
            if (typeof obj[key] === 'string') {
                const match = obj[key].match(FILE_VAR_REGEX);
                if (match) {
                    const varName = match[1];
                    if (fileVars[varName]) {
                        if (!loadedFiles[varName]) {
                            const filePath = path.resolve(fileVars[varName]);
                            console.log(`[INFO] Loading file for '${varName}' from ${filePath}`);
                            const fileBuffer = await readFile(filePath);
                            loadedFiles[varName] = Uint8Array.from(fileBuffer);
                        }
                        obj[key] = loadedFiles[varName];
                    } else {
                        throw new Error(`Manifest requires file variable '${varName}', but it was not provided via a --file argument.`);
                    }
                }
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                await recursiveInject(obj[key]);
            }
        }
    }

    await recursiveInject(manifest);
    return manifest;
}

async function packageManifest(args) {
    if (args.length === 0) {
        console.error('[ERROR] No manifest file provided for package command.');
        printHelp();
        process.exit(1);
    }

    const manifestPath = args.shift();
    let manifest, signerKeys;
    // Default output path is derived from the manifest file name.
    let outputPath = manifestPath.replace(/\.json$/, '.tx.bin');

    try {
        // 1. Parse command-line arguments for keys and files
        const keyArgs = {};
        const fileVars = {};
        const remainingArgs = [];
        let chainEnabled = true;

        let customOutfile = false;
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--outfile') {
                outputPath = args[i + 1];
                customOutfile = true;
                i++;
            } else if (args[i] === '--no-chain') {
                chainEnabled = false;
            } else if (args[i].startsWith('--')) {
                const key = args[i].slice(2);
                const value = args[i + 1];
                if (!value || value.startsWith('--')) {
                    console.error(`[ERROR] Missing value for argument: --${key}`);
                    process.exit(1);
                }
                if (key === 'file') {
                    const fileVarName = args[i + 1];
                    const filePath = args[i + 2];
                    if (!filePath || filePath.startsWith('--')) {
                        console.error(`[ERROR] Missing file path for --file ${fileVarName}`);
                        process.exit(1);
                    }
                    fileVars[fileVarName] = filePath;
                    i += 2;
                } else {
                    keyArgs[key] = value;
                    i++;
                }
            } else {
                remainingArgs.push(args[i]);
            }
        }

        if (customOutfile && outputPath === manifestPath.replace(/\.json$/, '.tx.bin')) {
            // If user specified --outfile but with the same name as the default, it's not an error, just redundant.
        } else if (outputPath === manifestPath) {
            console.error('[ERROR] Output file cannot be the same as the manifest file.');
            process.exit(1);
        }

        // 2. Read manifest content and handle $keyset directive
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
        }

        // 3. Inject file variables
        manifest = await injectFileVariables(manifest, fileVars);

        // 4. Load signer keys from arguments if not loaded from keyset
        if (Object.keys(signerKeys).length === 0) {
            if (Object.keys(keyArgs).length > 0) {
                console.log('[INFO] Loading keys from arguments...');
                for (const signerName in keyArgs) {
                    const keyPath = keyArgs[signerName];
                    const resolvedPath = path.resolve(keyPath);
                    console.log(`  - Loading key for '${signerName}' from ${resolvedPath}`);
                    signerKeys[signerName] = JSON.parse(await readFile(resolvedPath, 'utf-8'));
                }
            } else {
                // Fallback to old behavior if no --key args are provided.
                const signersToLoad = manifest.signers && Array.isArray(manifest.signers)
                    ? manifest.signers
                    : (manifest.feePayer ? [manifest.feePayer] : []);

                const requiredSigners = new Set(signersToLoad);
                if (manifest.feePayer) requiredSigners.add(manifest.feePayer);

                console.log('[INFO] Loading keys for required signers...');
                for (const signerName of requiredSigners) {
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
            }
        }

        // 5. Optionally resolve previous tx hash for chaining
        let prevTxHash = undefined;
        if (chainEnabled) {
            try {
                prevTxHash = await resolvePrevTxHash(manifest, signerKeys);
                if (prevTxHash) {
                    const prevHex = bytesToHex(prevTxHash);
                    console.log(`[INFO] Chaining enabled. Previous hash: ${prevHex}`);
                } else {
                    console.log('[INFO] No previous tx hash found. Building unchained transaction.');
                }
            } catch (e) {
                console.warn(`[WARN] Failed to resolve previous tx hash: ${e.message}`);
            }
        } else {
            console.log('[INFO] Chaining disabled by flag.');
        }

        const { tx, txId, linkId } = await createTransaction(manifest, signerKeys, { prevTxHash });
        await writeFile(outputPath, tx);
        console.log(`
[PASS] Transaction successfully created at ${outputPath}`);
        console.log(`[INFO] Base txId: ${txId}`);
        if (linkId) console.log(`[INFO] linkId (signed): ${linkId}`);

    } catch (error) {
        console.error(`
[FAIL] An error occurred during packaging: ${error.message}`);
        process.exit(1);
    }
}

const execFileAsync = promisify(execFile);

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) throw new Error('Invalid hex string');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

async function resolvePrevTxHash(manifest, signerKeys) {
    // Choose a signer address: prefer feePayer, otherwise first available signer key.
    const signerName = selectSignerNameForChaining(manifest, signerKeys);
    if (!signerName) {
        console.log('[INFO] No signer available/selected for chaining; skipping prevTxHash lookup.');
        return undefined;
    }

    // Compute signer address (bech32m and hex) from the provided keyset object.
    const handler = new PkmiCryptoHandler();
    await handler.loadKeysetFromObject(signerKeys[signerName]);
    const bech32 = handler.address.bech32m;
    const addrHex = bytesToHex(handler.address.raw).toLowerCase();

    const outfile = 'lastTxHash.json';
    let json;

    // Try to invoke external tool to write the file.
    try {
        console.log(`[INFO] Fetching last tx hash via 'lea' for ${bech32} -> ${outfile}`);
        await execFileAsync('lea', ['get-last-tx-hash', '--address', bech32, '--outfile', outfile]);
    } catch (e) {
        console.warn(`[WARN] External 'lea' call failed or not available: ${e.message}`);
    }

    // Try reading the JSON file regardless of whether the exec succeeded (it may already exist).
    try {
        const content = await readFile(outfile, 'utf-8');
        json = JSON.parse(content);
    } catch (e) {
        console.warn(`[WARN] Could not read/parse '${outfile}': ${e.message}. Treating as no chain.`);
        return undefined; // No file / invalid JSON → no chaining
    }

    const entry = json[addrHex] || json[addrHex.toUpperCase()] || json[addrHex.toLowerCase()];
    if (!entry) {
        console.log(`[INFO] No entry for address ${addrHex} in ${outfile}; skipping chaining.`);
        return undefined;
    }
    if (!Array.isArray(entry.lastTxHash)) {
        console.warn(`[WARN] Entry for ${addrHex} lacks a valid 'lastTxHash' array; skipping chaining.`);
        return undefined;
    }

    const arr = entry.lastTxHash;
    if (arr.length !== 32) {
        console.warn(`[WARN] lastTxHash length is ${arr.length}, expected 32; skipping chaining.`);
        return undefined;
    }
    const bytes = Uint8Array.from(arr);
    if (bytes.every(b => b === 0)) {
        console.log('[INFO] lastTxHash is all zeros; treating as no chain.');
        return undefined; // Treat all-zero as no chain
    }
    return bytes;
}

function selectSignerNameForChaining(manifest, signerKeys) {
    if (manifest && manifest.feePayer && signerKeys[manifest.feePayer]) return manifest.feePayer;
    if (manifest && Array.isArray(manifest.signers)) {
        for (const name of manifest.signers) {
            if (signerKeys[name]) return name;
        }
    }
    const names = Object.keys(signerKeys);
    return names.length ? names[0] : undefined;
}

async function decodeResult(args) {
    if (args.length < 2) {
        console.error('[ERROR] Missing arguments for decode-result command.');
        console.error('Usage: lea-ltm decode-result <result-path> <manifest-path>');
        process.exit(1);
    }
    const [resultPath, manifestPath] = args;

    try {
        console.log(`[INFO] Decoding result file: ${resultPath}`);
        console.log(`[INFO] Using manifest for schema: ${manifestPath}`);

        const resultBuffer = await readFile(resultPath);
        const resultBytes = Uint8Array.from(resultBuffer);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));

        const decoded = await decodeExecutionResult(resultBytes, manifest);

        console.log(`
[PASS] Decoded Execution Result:`);
        // Use console.dir for rich object printing (shows BigInt, Uint8Array types)
        console.dir(decoded, { depth: null });

    } catch (error) {
        console.error(`
[FAIL] An error occurred during result decoding: ${error.message}`);
        process.exit(1);
    }
}

function serializeDecodedValue(value) {
    if (value instanceof Uint8Array) {
        const serialized = { hex: value.hex };
        const bech32m = value.bech32m;
        if (bech32m) {
            serialized.bech32m = bech32m;
        }
        const info = value.info;
        if (info && typeof info === 'object' && Object.keys(info).length > 0) {
            serialized.info = serializeDecodedValue(info);
        }
        return serialized;
    }
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (Array.isArray(value)) {
        return value.map(item => serializeDecodedValue(item));
    }
    if (value instanceof Map) {
        const obj = {};
        for (const [key, val] of value.entries()) {
            obj[key] = serializeDecodedValue(val);
        }
        return obj;
    }
    if (typeof value === 'object') {
        const obj = {};
        for (const [key, val] of Object.entries(value)) {
            obj[key] = serializeDecodedValue(val);
        }
        return obj;
    }
    return value;
}

async function decodeTransactionCommand(args) {
    if (args.length === 0) {
        console.error('[ERROR] Missing transaction path for decode command.');
        console.error('Usage: lea-ltm decode <transaction-path> [--manifest <path>] [--outfile <path>] [--strip-vm-header]');
        process.exit(1);
    }

    let outfile = null;
    let stripVmHeader = false;
    let manifestPath = null;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--outfile') {
            if (i + 1 >= args.length) {
                console.error('[ERROR] Missing value for --outfile.');
                process.exit(1);
            }
            outfile = args[i + 1];
            i++;
        } else if (args[i] === '--manifest') {
            if (i + 1 >= args.length) {
                console.error('[ERROR] Missing value for --manifest.');
                process.exit(1);
            }
            manifestPath = args[i + 1];
            i++;
        } else if (args[i] === '--strip-vm-header') {
            stripVmHeader = true;
        } else {
            positional.push(args[i]);
        }
    }

    if (positional.length === 0) {
        console.error('[ERROR] Missing transaction path for decode command.');
        console.error('Usage: lea-ltm decode <transaction-path> [--manifest <path>] [--outfile <path>] [--strip-vm-header]');
        process.exit(1);
    }

    const [txPath] = positional;

    try {
        console.log(`[INFO] Decoding transaction file: ${txPath}`);
        const txBuffer = await readFile(txPath);
        const txBytes = Uint8Array.from(txBuffer);

        let manifest = null;
        if (manifestPath) {
            console.log(`[INFO] Using manifest hints from: ${manifestPath}`);
            const manifestSource = await readFile(manifestPath, 'utf-8');
            manifest = JSON.parse(manifestSource);
        }

        const decoded = await decodeTransaction(txBytes, { stripVmHeader, manifest });
        const jsonReady = serializeDecodedValue(decoded);
        const jsonOutput = JSON.stringify(jsonReady, null, 2);

        if (outfile) {
            await writeFile(outfile, jsonOutput);
            console.log(`
[PASS] Decoded transaction written to ${outfile}`);
        } else {
            console.log(`
[PASS] Decoded Transaction:`);
            console.log(jsonOutput);
        }
    } catch (error) {
        console.error(`
[FAIL] An error occurred during transaction decoding: ${error.message}`);
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
        case 'decode-result':
            await decodeResult(commandArgs);
            break;
        case 'decode':
            await decodeTransactionCommand(commandArgs);
            break;
        default:
            // Allow 'package' to be the default command
            await packageManifest(args);
            break;
    }
}

main();
