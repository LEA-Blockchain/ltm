# msctp.js

This directory contains the JavaScript (ESM) implementation of the Micro-SCTP Encoding Standard. It is designed to be fully compatible with the reference C implementation.

## Files

- `msctp.js`: The core library providing encoding and decoding functions for `ULEB128`, `SLEB128`, and `Vector` types.
- `msctp-cli.mjs`: A command-line tool for encoding and decoding `msctp` data, useful for testing and interoperability.
- `test.mjs`: (If it exists) A test suite for verifying the correctness of the JS implementation.

## Usage

### Library

The `msctp.js` module exports high-level `MsctpEncoder` and `MsctpDecoder` classes for easily working with streams of MSCTP objects.

**Encoding a mixed stream of data:**
```javascript
import { MsctpEncoder } from './msctp.js';
import { promises as fs } from 'fs';

const encoder = new MsctpEncoder();

encoder.addUleb128(42n);
encoder.addVector(new TextEncoder().encode("hello world"));
encoder.addSleb128(-101n);

const buffer = encoder.build();
await fs.writeFile('mixed.bin', buffer);
```

**Decoding a mixed stream of data:**
```javascript
import { MsctpDecoder, MSCTP_TT_ULEB128, MSCTP_TT_SLEB128, MSCTP_TT_SMALL_VECTOR, MSCTP_TT_LARGE_VECTOR } from './msctp.js';
import { promises as fs } from 'fs';

const buffer = await fs.readFile('mixed.bin');
const decoder = new MsctpDecoder(buffer);

while (decoder.hasNext()) {
    const type = decoder.peekType();
    if (type === MSCTP_TT_ULEB128) {
        console.log('Found ULEB128:', decoder.readUleb128());
    } else if (type === MSCTP_TT_SLEB128) {
        console.log('Found SLEB128:', decoder.readSleb128());
    } else if (type === MSCTP_TT_SMALL_VECTOR || type === MSCTP_TT_LARGE_VECTOR) {
        const vector = decoder.readVector();
        console.log(`Found Vector (len ${vector.length}): "${new TextDecoder().decode(vector)}"`);
    }
}
```

### Command-Line Tool (`msctp-cli.mjs`)

The CLI provides a convenient way to encode and decode MSCTP streams for testing and interoperability.

**Encoding Options (can be repeated):**
- `--uleb <value>`: Encode an unsigned BigInt.
- `--sleb <value>`: Encode a signed BigInt.
- `--vector <string>`: Encode a string as a vector.
- `-o <file>`: Write encoded output to `<file>` (default: stdout).

**Decoding Options:**
- `-d [file]`: Decode a stream of objects from `<file>` (default: stdin).

**Examples:**
```sh
# Encode a mixed stream and save it to a file
node js/msctp-cli.mjs --uleb 42 --vector "hello" --sleb -100 -o mixed.bin

# Decode the stream from the file
node js/msctp-cli.mjs -d mixed.bin
# ULEB128: 42
# Vector (len 5): "hello"
# SLEB128: -100
```
