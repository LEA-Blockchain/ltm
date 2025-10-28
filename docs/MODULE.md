<!--
giturl: https://github.com/LEA-Blockchain/ltm
name: ltm
version: 1.0.0
description: A library for resolving and encoding LEA Transaction Manifests.
-->

# @getlea/ltm

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
npm install @getlea/ltm
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
import { createTransaction } from '@getlea/ltm';
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

The `@getlea/ltm` library exports four primary functions:

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

Decodes a binary transaction into the canonical manifest-style structure the encoder uses. All SCTP vectors remain `Uint8Array`s so you can re-encode the decoded object without losing fidelity.

-   **`txBytes`** `<Uint8Array>`: Raw transaction bytes (include the Lea VM header if present).
-   **`options`** `<Object>` *(optional)*:
    -   `stripVmHeader` `<boolean>`: Set to `true` when `txBytes` is prefixed with the Lea VM wrapper (`LEAB` magic + length).
    -   `manifest` `<Object>`: The authoring manifest. When supplied the decoder uses it to recover instruction types (e.g., `INLINE`, `$pubset(...)`) and annotate inline payloads.
-   **Returns**: `<Object>` containing `pod`, `version`, `sequence`, `gasLimit`, `gasPrice`, `addresses`, `invocations`, `signatures`, and optional `vmHeader`. Every `Uint8Array` exposes lazy getters:
    -   `.hex` – canonical lowercase hex.
    -   `.bech32m` – available for address fields when the HRP is known.
    -   `.info` – metadata describing the field (instruction kind, signer, etc.). For pubsets you’ll also find `info.keys` (with empty `sk` placeholders and decoded `pk`) and `info.keyset` shaped like `[[sk, pk], [sk, pk]]` for Ed25519 and Falcon-512 respectively.

> **Shorthand:** For convenience you can pass the manifest object directly as the second argument (`decodeTransaction(txBytes, manifest)`); it’s equivalent to `decodeTransaction(txBytes, { manifest })`.

#### Example: Decoding with Manifest Hints

```javascript
import { decodeTransaction } from '@getlea/ltm';
import { promises as fs } from 'fs';

const txBytes = await fs.readFile('./transaction.bin');
const manifest = JSON.parse(await fs.readFile('./manifests/minimal.json', 'utf-8'));

const decoded = decodeTransaction(txBytes, { manifest });

console.log(decoded.pod.hex);                   // 'pod' as hex
console.log(decoded.addresses[0].bech32m);      // First address as bech32m

for (const instruction of decoded.invocations[0].instructions) {
  if (instruction.INLINE) {
    console.log(instruction.INLINE.info);       // e.g. { kind: 'pubset', signer: 'publisher' }
  }
}
```

#### Decoded Object Shape

```ts
type DecodedTransaction = {
  pod: Uint8Array;                 // raw 32-byte POD prefix
  version: number | string;        // ULEB128, string when > Number.MAX_SAFE_INTEGER
  sequence: number | string;
  gasLimit: number | string;
  gasPrice: number | string;
  addresses: Uint8Array[];         // every entry has .hex / .bech32m / .info
  invocations: Array<{
    targetAddress: number;
    instructions: Array<
      | { uleb: number | string; comment?: string }
      | { sleb: number | string; comment?: string }
      | { vector: Uint8Array & ByteDecorators; comment?: string }
      | { INLINE: Uint8Array & ByteDecorators; comment?: string }
    >;
  }>;
  signatures: Array<{
    ed25519: Uint8Array & ByteDecorators;
    falcon512: Uint8Array & ByteDecorators;
  }>;
  vmHeader?: { magic: string; version: number; length: number };
  hashes?: {
    base(): Promise<Uint8Array>;   // blake3(pod || preSignatureSection)
    baseHex(): Promise<string>;
    preSignature: Uint8Array;      // raw bytes up to the first signature
    signatureSection: Uint8Array;  // raw signature payload
  };
};

type ByteDecorators = {
  hex: string;
  bech32m?: string;
  info: Record<string, any>;
};
```

- Addresses live in `decoded.addresses`; fetch the bytes for an invocation with `decoded.addresses[invocation.targetAddress]`.
- For inline pubsets, `instruction.INLINE` is the original serialized MSCTP chunk, while `instruction.INLINE.info.keyset` gives you the `[[sk, pk], [sk, pk]]` structure (secret keys are zero-length stubs to avoid ever leaking private material).
- Use `await decoded.hashes.base()` (or `baseHex()`) to recompute the Blake3 hash of the unsigned payload; combine it with `decoded.hashes.signatureSection` if you need to re-verify signatures externally.

Because every vector remains a `Uint8Array`, you can feed the decoded structure back into your own encoder (or the provided helpers in `src/core`) and reproduce the original bytes exactly when needed.

### `decodeExecutionResult(resultBuffer, manifest)`

Decodes a binary execution result from a transaction using the `resultSchema` defined in a manifest.

-   **`resultBuffer`** `<Uint8Array>`: The raw binary buffer returned from a transaction execution.
-   **`manifest`** `<Object>`: The original LTM manifest containing the `resultSchema`.
-   **Returns**: `<Promise<Object>>` A promise that resolves to a structured JavaScript object representing the decoded result.

#### Example: Decoding a Result

```javascript
import { decodeExecutionResult } from '@getlea/ltm';
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

### `verifyTransactionWithKeyset(input, keyset, options)`

High-level helper to validate single-signer Lea transactions produced by `createTransaction`.

-   **`input`** `<Uint8Array | DecodedTransaction>`: Either the raw transaction bytes or the object returned by `decodeTransaction`.
-   **`keyset`** `<Object | Array>`: Either the standard Lea keyset object (`{ ed25519: { pk }, falcon512: { pk } }`), a full key file (`{ keyset: [...] }`), or the inline pubset array (`[[sk, pk], [sk, pk]]`). Secret keys are ignored.
-   **`options`** `<Object>` *(optional)*:
    -   `stripVmHeader` `<boolean>`: Only used when `input` is bytes; set true if the transaction includes a Lea VM wrapper.
-   **Returns**: `<Promise<{ ok: boolean, ed25519: boolean, falcon512: boolean }>>`

```javascript
import { verifyTransactionWithKeyset } from '@getlea/ltm';

const decoded = decodeTransaction(txBytes, manifest);
const keyset = decoded.invocations[0].instructions[1].INLINE.info.keyset;
const result = await verifyTransactionWithKeyset(decoded, keyset);

console.log(result.ok); // true when both signatures verify
```

## Contributing

Contributions are welcome. Please refer to the project's contribution guidelines for more information.

## License

This project is licensed under the ISC License. See the [LICENSE](https://raw.githubusercontent.com/LEA-Blockchain/ltm/refs/heads/main/LICENSE) file for details.
