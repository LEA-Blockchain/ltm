<!--
giturl: https://github.com/LEA-Blockchain/ltm
name: lea-ltm
version: 1.0.0
description: A library and CLI for resolving and encoding LEA Transaction Manifests.
-->

# @leachain/ltm

[![npm version](https://img.shields.io/npm/v/@leachain/ltm.svg)](https://www.npmjs.com/package/@leachain/ltm)
[![License](https://img.shields.io/npm/l/@leachain/ltm.svg)](https://github.com/LEA-Blockchain/ltm/blob/main/LICENSE)

This package provides a library and a command-line tool for resolving and encoding human-readable **Lea Transaction Manifests (LTM)** into the binary SCTP format used by the Lea network.

It is composed of two main parts:
- A **Node.js library** for programmatically creating transactions.
- A **command-line tool (`lea-ltm`)** for packaging and verifying manifests from your terminal.

## Motivation

The process of creating a valid LEA transaction, as defined in LIP-7, requires precise binary encoding using the Simple Compact Transaction Protocol (SCTP). Constructing this binary stream programmatically is a low-level task that is verbose, error-prone, and requires custom scripting for each new type of transaction. This approach tightly couples the transaction's data with the application logic, making it difficult to manage, reuse, or audit transaction definitions.

The LEA Transaction Manifest (LTM) introduces a declarative layer that solves this problem. By defining a transaction in a structured JSON format, users can clearly specify all its components (such as signers, gas parameters, and contract invocations) without writing any encoding logic. The LTM format is designed to be processed by a build tool that handles all the underlying complexities of data resolution, SCTP encoding, hashing, and signing. This separation of concerns dramatically simplifies the user experience, reduces the risk of malformed transactions, and promotes the creation of reusable transaction templates.

## Documentation

Full documentation is available for both the library and the CLI tool.

-   **[Node.js Module Documentation](./docs/MODULE.md)**: For developers using this package as a library in their applications.
-   **[Command-Line Tool (CLI) Documentation](./docs/CLI.md)**: For users who want to use the `lea-ltm` command-line tool.

For a detailed explanation of the JSON manifest structure, its fields, and the use of dynamic variables like `$addr()` and `$const()`, please see the official format documentation:

- **[Lea Transaction Manifest Format](./docs/LTM_FORMAT.md)**

## Key Files

Use `lea-keygen` to generate signer key files in the new format. Each file contains a `keyset` and the derived address fields:

```sh
lea-keygen new --outfile examples/keys/registrar.keys.json
```

Expected shape (truncated):

```json
{
  "keyset": [[<ed25519_sk>, <ed25519_pk>], [<falcon512_sk>, <falcon512_pk>]],
  "address": "lea1...",
  "addressHex": "..."
}
```

Pass these files to the CLI using `--<signerName> <path>` (e.g., `--registrar examples/keys/registrar.keys.json`).

## License

This project is licensed under the ISC License. See the `LICENSE` file for details.
