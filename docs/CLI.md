<!--
giturl: https://github.com/LEA-Blockchain/ltm
name: lea-ltm
version: 1.0.0
description: A library and CLI for resolving and encoding LEA Transaction Manifests.
-->

# lea-ltm Command-Line Usage

[![npm version](https://img.shields.io/npm/v/@getlea/ltm.svg)](https://www.npmjs.com/package/@getlea/ltm)
[![License](https://img.shields.io/npm/l/@getlea/ltm.svg)](https://github.com/LEA-Blockchain/ltm/blob/main/LICENSE)

This guide provides detailed instructions for using the `lea-ltm` command-line tool to package, inspect, and manage Lea Transaction Manifests (LTM).

## Installation

For one-off use, `npx` is recommended as it ensures you are always using the latest version:
```sh
npx @leachain/ltm <command>
```

For frequent use, you can install the package globally:
```sh
npm install -g @leachain/ltm
lea-ltm <command>
```

## Key Files & lea-keygen

The CLI expects signer key files in the new object format produced by `lea-keygen`:

```sh
lea-keygen new --outfile ./keys/sender.keys.json
```

Key file shape (truncated):

```json
{
  "keyset": [[<ed25519_sk>, <ed25519_pk>], [<falcon512_sk>, <falcon512_pk>]],
  "address": "lea1...",
  "addressHex": "..."
}
```

Use them with `package` via `--<signerName> <path>`, for example:

```sh
lea-ltm ./manifests/minimal.json --registrar ./keys/registrar.keys.json
```

## Command Reference

The `lea-ltm` tool supports four commands: `package`, `verify`, `decode`, and `decode-result`.

---

### `package`

Packages a human-readable JSON manifest file into a binary transaction file according to the SCTP specification. This is the **default command**, so you can omit the `package` keyword.

#### Usage

```sh
# Default command
lea-ltm <manifest-path> [options]

# Explicit command
lea-ltm package <manifest-path> [options]
```

#### Options

| Option                                | Description                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--<signerName> <path>`               | Provide the key file for a required signer (e.g., `--deployer ./d.json`).                                  |
| `--file <variable> <path>`            | Load a file as binary data and assign it to a `$variable` placeholder in the manifest.                     |
| `--outfile <path>`                    | Specify the output file path for the binary transaction. Defaults to the manifest name with a `.tx.bin` extension. |

#### Examples

**1. Basic Packaging**

For a simple manifest signed by a single "registrar" account:

```sh
lea-ltm ./manifests/minimal.json --registrar ./keys/registrar.json
```

**2. Multi-Signer Transaction**

For a manifest requiring signatures from both a `sender` and a `cosigner`:

```sh
lea-ltm ./manifests/multi-signer.json \
  --sender ./keys/sender.json \
  --cosigner ./keys/cosigner.json
```

**3. Injecting a File and Naming the Output**

To deploy a smart contract, this command injects the Wasm bytecode from a file into the manifest and names the output `deploy.bin`:

```sh
lea-ltm ./manifests/deploy.json \
  --deployer ./keys/deployer.json \
  --file contract_code ./contracts/my_contract.wasm \
  --outfile deploy.bin
```

**4. Using the `$keyset` Directive (Local Development)**

If your manifest contains a `$keyset` directive pointing to a file with all necessary keys, no `--<signerName>` arguments are needed:

```sh
# Manifest contains: "keyset": "$keyset(./private.json)"
lea-ltm ./manifest.json
```

---

### `verify`

Decodes and inspects a binary transaction file (`.bin`), printing its contents in a human-readable format. This is useful for debugging or confirming the contents of a transaction before broadcasting it.

#### Usage

```sh
lea-ltm verify <transaction-path> [manifest-path]
```

#### Arguments

-   `<transaction-path>`: The path to the binary `transaction.bin` file.
-   `[manifest-path]` (optional): If provided, the tool will cross-reference the decoded transaction against the original manifest to validate fields like `sequence`, `gasLimit`, etc. If the manifest contains an `INLINE` instruction, the verifier will show a warning and skip the detailed check for that specific instruction.

#### Examples

**1. Decode a Transaction**

```sh
lea-ltm verify ./transaction.bin
```

**2. Decode and Validate Against a Manifest**

```sh
lea-ltm verify ./deploy.bin ./manifests/deploy.json
```

---

### `decode`

Decodes a binary transaction into the canonical manifest-style JSON that the signer sees, optionally stripping the Lea VM header emitted by some runtimes.

#### Usage

```sh
lea-ltm decode <transaction-path> [--outfile <path>] [--strip-vm-header]
```

#### Options

| Option                  | Description                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| `--outfile <path>`      | Write the decoded JSON to a file instead of stdout.                         |
| `--strip-vm-header`     | Remove the Lea VM header (`LEAB` magic + length) before decoding.           |

#### Examples

**1. Print the canonical manifest to stdout**

```sh
lea-ltm decode ./transaction.bin
```

**2. Decode a VM-wrapped file and save the JSON**

```sh
lea-ltm decode ./vm-output.tx --strip-vm-header --outfile ./decoded.json
```

---

### `decode-result`

Decodes a transaction execution result using the `resultSchema` embedded in the manifest.

#### Usage

```sh
lea-ltm decode-result <result-path> <manifest-path>
```

#### Example

```sh
lea-ltm decode-result ./result.bin ./manifests/deploy.json
```

## License

This project is licensed under the ISC License. See the [LICENSE](LICENSE) file for details.
