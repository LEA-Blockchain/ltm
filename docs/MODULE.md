<!--
giturl: https://github.com/LEA-Blockchain/ltm
name: ltm
version: 1.0.0
description: A library for resolving and encoding LEA Transaction Manifests.
-->

# @leachain/ltm

[![npm version](https://img.shields.io/npm/v/@getlea/ltm.svg)](https://www.npmjs.com/package/@getlea/ltm)
[![License](https://img.shields.io/npm/l/@getlea/ltm.svg)](https://github.com/LEA-Blockchain/ltm/blob/main/LICENSE)

This package provides a library for resolving and encoding human-readable **Lea Transaction Manifests (LTM)** into the binary SCTP format used by the Lea network, and for decoding transactions/results back into canonical JSON.

## Features

-   **Human-Readable Manifests**: Define complex transactions in a simple, readable JSON format.
-   **Advanced Resolution**: Automatically resolves and sorts addresses and signers according to network rules.
-   **Cross-Platform**: The core library works in both Node.js and modern browsers.
-   **Flexible**: Handles complex scenarios like multi-signer transactions and dynamic data resolution.

## Installation

```sh
npm install @leachain/ltm
```

## Key Files

Generate signer key files with `lea-keygen`. The library expects each signer entry to be a parsed object with this shape:

```json
{
  "keyset": [[<ed25519_sk>, <ed25519_pk>], [<falcon512_sk>, <falcon512_pk>]],
  "address": "lea1...",
  "addressHex": "..."
}
```

Load them from disk and pass as `signerKeys = { <signerName>: keyObject }`.

## Usage (Quick Start)

The following example demonstrates how to use the core `createTransaction` function to build a transaction programmatically.

```javascript
import { createTransaction } from '@leachain/ltm';
import { promises as fs } from 'fs';

// 1. Define a transaction manifest object.
// This object defines the transaction's parameters and instructions.
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

// 2. Load signer keys (new format produced by lea-keygen).
const senderKeys = JSON.parse(await fs.readFile('./sender.keys.json', 'utf-8'));

// The createTransaction function expects a dictionary mapping signer names
// from the manifest to their corresponding key objects.
const signerKeys = {
  sender: senderKeys
};

// 3. Create the binary transaction.
try {
  const { tx, txId } = await createTransaction(manifest, signerKeys);
  await fs.writeFile('transaction.bin', tx);
  console.log('[PASS] Transaction created successfully!');
  console.log('TxID:', txId);
} catch (error) {
  console.error('[FAIL]', error.message);
}
```

## API Reference

The `@leachain/ltm` library exports four primary functions:

### `createTransaction(manifest, signerKeys, options)`

Creates and signs a binary transaction from a manifest object and signer keys.

-   **`manifest`** `<Object>`: The LTM manifest object.
-   **`signerKeys`** `<Object>`: Map of signer name to key object (new lea-keygen format).
-   **`options`** `<Object>` *(optional)*:
    -   `prevTxHash` `<Uint8Array>`: Provide a 32-byte previous transaction hash to enable chaining.
-   **Returns**: `<Promise<{ tx: Uint8Array, txId: string, linkId?: string }>>` Encoded transaction bytes, the hex `txId`, and (when chaining) the `linkId` that was actually signed.

### `resolveManifest(manifest)`

Resolves a manifest by processing constants, ordering addresses, and preparing it for encoding. This is useful for inspecting how a manifest will be structured before creating the final transaction.

-   **`manifest`** `<Object>`: The LTM manifest object.
-   **Returns**: `<Promise<Object>>` A promise that resolves to the resolved manifest object.

### `decodeTransaction(txBytes, options)`

Decodes a binary transaction into the canonical manifest-style JSON that the signer validated.

-   **`txBytes`** `<Uint8Array>`: The raw transaction bytes. You can load them with `await fs.readFile(path)`.
-   **`options`** `<Object>` *(optional)*:
    -   `stripVmHeader` `<boolean>`: Set to `true` if the buffer includes the Lea VM wrapper (`LEAB` magic + length prefix).
-   **Returns**: `<Object>` A plain object containing `pod`, `version`, `sequence`, `gasLimit`, `gasPrice`, `addresses`, `invocations`, `signatures`, and (when present) `vmHeader`.

#### Example: Decoding a Transaction

```javascript
import { decodeTransaction } from '@leachain/ltm';
import { promises as fs } from 'fs';

const bytes = await fs.readFile('./vm-output.tx');
const decoded = decodeTransaction(bytes, { stripVmHeader: true });

console.log(decoded.pod); // hex string
console.log(decoded.invocations[0].instructions);
```

### `decodeExecutionResult(resultBuffer, manifest)`

Decodes a binary execution result from a transaction using the `resultSchema` defined in a manifest.

-   **`resultBuffer`** `<Uint8Array>`: The raw binary buffer returned from a transaction execution.
-   **`manifest`** `<Object>`: The original LTM manifest containing the `resultSchema`.
-   **Returns**: `<Promise<Object>>` A promise that resolves to a structured JavaScript object representing the decoded result.

#### Example: Decoding a Result

```javascript
import { decodeExecutionResult } from '@leachain/ltm';
import { promises as fs } from 'fs';

// 1. Load the manifest that contains the 'resultSchema'.
const manifestWithSchema = JSON.parse(
  await fs.readFile('./manifest.json', 'utf-8')
);

// 2. Load the binary result data from the network.
const resultBuffer = await fs.readFile('./execution-result.bin');

// 3. Decode the result.
try {
  const decoded = await decodeExecutionResult(resultBuffer, manifestWithSchema);
  console.log('[PASS] Decoded Result:');
  console.dir(decoded, { depth: null });
  // Example Output:
  // Decoded Result:
  // {
  //   'lea1...': { newBalance: 1234n, recipientAddress: <Uint8Array> }
  // }
} catch (error) {
  console.error('[FAIL]', error.message);
}
```

## Contributing

Contributions are welcome. Please refer to the project's contribution guidelines for more information.

## License

This project is licensed under the ISC License. See the [LICENSE](LICENSE) file for details.
