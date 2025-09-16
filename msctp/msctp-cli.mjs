#!/usr/bin/env node

import * as fs from 'fs/promises';
import {
    MsctpEncoder,
    MsctpDecoder,
    MsctpError,
    MSCTP_TT_ULEB128,
    MSCTP_TT_SLEB128,
    MSCTP_TT_SMALL_VECTOR,
    MSCTP_TT_LARGE_VECTOR
} from './msctp.js';

function printUsage(progName) {
    console.error(`MSCTP Encoder/Decoder CLI (JS)`);
    console.error(`Usage: node ${progName} [options]
`);
    console.error(`Encoding Options (can be repeated):`);
    console.error(`  --uleb <value>      Encode an unsigned BigInt.`);
    console.error(`  --sleb <value>      Encode a signed BigInt.`);
    console.error(`  --vector <string>   Encode a string as a vector.`);
    console.error(`  -o <file>           Write encoded output to <file> (default: stdout).
`);
    console.error(`Decoding Options:`);
    console.error(`  -d [file]           Decode a stream of objects from <file> (default: stdin).
`);
    console.error(`Examples:`);
    console.error(`  node ${progName} --uleb 42 --vector "hello" --sleb -100 -o mixed.bin`);
    console.error(`  node ${progName} -d mixed.bin`);
}

async function handleDecode(infile) {
    let buffer;
    try {
        if (infile) {
            buffer = await fs.readFile(infile);
        } else {
            const chunks = [];
            for await (const chunk of process.stdin) {
                chunks.push(chunk);
            }
            buffer = Buffer.concat(chunks);
        }
    } catch (e) {
        console.error(`[ERROR] Cannot read input: ${e.message}`);
        process.exit(1);
    }

    if (buffer.length === 0) {
        return;
    }

    const decoder = new MsctpDecoder(buffer);
    let object_count = 0;

    while (decoder.hasNext()) {
        object_count++;
        const tt = decoder.peekType();
        try {
            if (tt === MSCTP_TT_ULEB128) {
                const val = decoder.readUleb128();
                console.log(`ULEB128: ${val}`);
            } else if (tt === MSCTP_TT_SLEB128) {
                const val = decoder.readSleb128();
                console.log(`SLEB128: ${val}`);
            } else if (tt === MSCTP_TT_SMALL_VECTOR || tt === MSCTP_TT_LARGE_VECTOR) {
                const payload = decoder.readVector();
                const text = new TextDecoder().decode(payload);
                console.log(`Vector (len ${payload.length}): "${text}"`);
            } else {
                throw new MsctpError(`Invalid MSCTP type tag: ${tt} at offset ${decoder.offset}`, -1);
            }
        } catch (e) {
            if (e instanceof MsctpError) {
                console.error(`[ERROR] Failed to decode object ${object_count}. Code: ${e.code}, Msg: ${e.message}`);
            } else {
                console.error(`[ERROR] An unexpected error occurred during decoding: ${e.message}`);
            }
            process.exit(1);
        }
    }
}


async function main() {
    const args = process.argv.slice(2);
    const progName = process.argv[1].split('/').pop();

    if (args.length === 0) {
        printUsage(progName);
        process.exit(1);
    }

    const decodeFlagIndex = args.findIndex(arg => arg === '-d');
    const outFileIndex = args.findIndex(arg => arg === '-o');
    
    let isDecodeMode = decodeFlagIndex !== -1;
    let outputFile;
    if (outFileIndex !== -1) {
        outputFile = args[outFileIndex + 1];
        if (!outputFile) {
            console.error("[ERROR] Missing filename for -o");
            process.exit(1);
        }
    }

    const hasEncodingFlags = args.some(arg => arg.startsWith('--'));
    if (hasEncodingFlags && isDecodeMode) {
        console.error("[ERROR] Cannot mix encoding and decoding flags.");
        process.exit(1);
    }

    if (isDecodeMode) {
        let decodeFile;
        if (decodeFlagIndex + 1 < args.length && !args[decodeFlagIndex + 1].startsWith('-')) {
            decodeFile = args[decodeFlagIndex + 1];
        }
        await handleDecode(decodeFile);
        return;
    }

    if (hasEncodingFlags) {
        const encoder = new MsctpEncoder();
        try {
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg.startsWith('--')) {
                    const type = arg;
                    if (i + 1 >= args.length) {
                        throw new Error(`Missing value for ${type}`);
                    }
                    const valueStr = args[++i];
                    if (type === '--uleb') {
                        encoder.addUleb128(BigInt(valueStr));
                    } else if (type === '--sleb') {
                        encoder.addSleb128(BigInt(valueStr));
                    } else if (type === '--vector') {
                        encoder.addVector(new TextEncoder().encode(valueStr));
                    }
                }
            }

            const finalBuffer = encoder.build();
            if (finalBuffer.length === 0) {
                 printUsage(progName);
                 process.exit(1);
            }

            if (outputFile) {
                await fs.writeFile(outputFile, finalBuffer);
            } else {
                process.stdout.write(finalBuffer);
            }

        } catch (e) {
            console.error(`[ERROR] Failed to encode: ${e.message}`);
            process.exit(1);
        }
        return;
    }

    printUsage(progName);
    process.exit(1);
}

main().catch(err => {
    console.error("An unhandled error occurred:", err);
    process.exit(1);
});