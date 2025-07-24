<!--
giturl: https://github.com/LEA-Blockchain/ltm
name: lea-ltm
version: 1.0.0
description: A library and CLI for resolving and encoding LEA Transaction Manifests.
-->

# @leachain/ltm

[![npm version](https://img.shields.io/npm/v/@leachain/ltm.svg)](https://www.npmjs.com/package/@leachain/ltm)
[![License](https://img.shields.io/npm/l/@leachain/ltm.svg)](https://github.com/LEA-Blockchain/ltm/blob/main/LICENSE)

This package provides a library and a command-line tool (`lea-ltm`) for resolving and encoding human-readable **Lea Transaction Manifests (LTM)** into the binary SCTP format used by the Lea network.

## Features

-   **Human-Readable Manifests**: Define complex transactions in a simple, readable JSON format.
-   **Advanced Resolution**: Automatically resolves and sorts addresses and signers according to network rules.
-   **Powerful CLI Tool**: Package manifests into binary transactions directly from the command line.
-   **Flexible Key Management**: Load signer keys from a unified keyset file or provide them individually as command-line arguments.
-   **Cross-Platform**: The core library works in both Node.js and modern browsers.

## Library Usage

### Installation

```sh
npm install @leachain/ltm
```

### Quick Start

The following example demonstrates how to use the core `createTransaction` function to build a transaction programmatically.

```javascript
import { createTransaction } from '@leachain/ltm';
import { promises as fs } from 'fs';

// 1. Define a transaction manifest object
const manifest = {
  sequence: 1,
  feePayer: 'sender',
  gasLimit: 100000,
  gasPrice: 10,
  invocations: [
    {
      targetAddress: '$addr(lea19sk08nl545jzjvmx3qzryahz94mlcaxmqhrrnl3slw83ys53p08qj3zkcw)',
      instructions: [
        { uleb: 1 }, // Op-code for 'transfer'
        { uint64: '500' } // Amount
      ]
    }
  ]
};

// 2. Load the necessary keyset(s) for the signers
// The keyset for the 'sender' (the feePayer) is required.
const senderKeys = JSON.parse(await fs.readFile('./sender.keys.json', 'utf-8'));

const signerKeys = {
  sender: senderKeys
};

// 3. Create the binary transaction
try {
  const transactionBytes = await createTransaction(manifest, signerKeys);
  await fs.writeFile('transaction.bin', transactionBytes);
  console.log('[PASS] Transaction created successfully!');
  console.log('Output:', transactionBytes);
} catch (error) {
  console.error('[FAIL]', error.message);
}
```

---

## Command-Line Tool: `lea-ltm`

The `lea-ltm` tool provides a powerful command-line interface for packaging and inspecting Lea transactions.

### Installation

For one-off use, `npx` is recommended:
```sh
npx @leachain/ltm <command>
```

For frequent use, you can install it globally:
```sh
npm install -g @leachain/ltm
lea-ltm <command>
```

### Command Reference

#### `package`
Packages a JSON manifest file into a binary transaction. This is the default command.

**Usage:**
`lea-ltm package <manifest-path> [key-options]`
`lea-ltm <manifest-path> [key-options]` (as default)

-   `<manifest-path>`: The path to the JSON manifest file.
-   `[key-options]`: A list of key files for the required signers.

The tool provides two primary methods for supplying the cryptographic keys required for signing.

**Method 1: Individual Key Arguments (Recommended)**

You can provide the path to each required signer's keyset file using command-line flags. The required signer names are determined by the `feePayer` and `signers` fields in the manifest.

For a manifest with `feePayer: "admin"`, you would run:
```sh
lea-ltm package ./manifests/transaction.json --admin /path/to/admin.keys.json
```

For a multi-signer manifest with `feePayer: "sender"` and `signers: ["cosigner"]`:
```sh
lea-ltm ./m.json --sender ./s.keys.json --cosigner ./c.keys.json
```

**Method 2: `$keyset` Directive**

As a convenience for local development, you can embed a special `$keyset` directive inside your manifest file. The CLI will load the specified file as a dictionary containing all required keys.

**Note:** This directive is a CLI-specific feature and is stripped from the manifest before processing. It is not part of the official LTM format.

**Example Manifest (`manifest.json`):**
```json
{
  "feePayer": "registrar",
  "keyset": "$keyset(./private.json)",
  "invocations": [ ... ]
}
```

**Command:**
```sh
lea-ltm package ./manifest.json
```

---

#### `verify`
Decodes and inspects a binary transaction file, printing its contents in a human-readable format.

**Usage:**
`lea-ltm verify <transaction-path> [manifest-path]`

-   `<transaction-path>`: The path to the binary `transaction.bin` file.
-   `[manifest-path]` (optional): If provided, the tool will cross-reference the decoded transaction against the original manifest to validate fields like `sequence`, `gasLimit`, etc.

**Example:**
```sh
# Decode and print the contents of a transaction
lea-ltm verify ./transaction.bin

# Decode and also validate against a manifest
lea-ltm verify ./transaction.bin ./manifests/original.json
```

## Lea Transaction Manifest (LTM) Format

For a detailed explanation of the JSON manifest structure, its fields, and the use of dynamic variables like `$addr()` and `$const()`, please see the official format documentation:

**[Lea Transaction Manifest Format](./LTM_FORMAT.md)**

## License

This project is licensed under the ISC License. See the `LICENSE` file for details.
