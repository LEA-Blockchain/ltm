# Lea Transaction Manifest (LTM) Format

The Lea Transaction Manifest (LTM) is a human-readable JSON format designed to describe all the components of a transaction before it is encoded into its final binary form. It provides a flexible and developer-friendly way to define everything from simple value transfers to complex multi-party contract interactions.

## Core Structure

An LTM file is a JSON object with a set of top-level fields that define the transaction's parameters and execution flow.

```json
{
  "comment": "A brief, human-readable description of the transaction's purpose.",
  "sequence": 1,
  "feePayer": "sender",
  "gasLimit": 500000,
  "gasPrice": 10,
  "signers": [ "cosigner1", "cosigner2" ],
  "constants": {
    "mainContract": "lea1...",
    "someValue": 12345
  },
  "invocations": [
    { ... },
    { ... }
  ]
}
```

---

## Top-Level Fields

#### `comment` (string, optional)
A description of the transaction's purpose. This field is for human use only and is ignored during processing.

#### `pod` (string, optional)
The 32-byte address of the on-chain `Decoder` contract responsible for interpreting the transaction's payload, as specified in LIP-0009. This value should be provided as a 64-character hexadecimal string. If omitted, a default `pod` address will be used.
This effectively acts as a routing address, telling the Lea network which logic to use to validate and execute the transaction.

#### `sequence` (number, required)
The transaction sequence number (nonce) for the `feePayer`'s account. This is used to prevent replay attacks.

#### `feePayer` (string, required)
The logical name of the account responsible for paying the transaction fees. This name **must** correspond to a key provided to the signing tool (e.g., `lea-ltm --sender <key-file>`). The `feePayer` is always the first and primary signer of the transaction.

#### `gasLimit` (number, required)
The maximum number of gas units that the transaction is allowed to consume.

#### `gasPrice` (number, required)
The price (in the network's smallest unit) that the `feePayer` is willing to pay per unit of gas.

#### `signers` (array of strings, optional)
A list of logical names for any additional accounts that must co-sign the transaction. Like `feePayer`, each name in this list must correspond to a key provided to the signing tool. These signers are secondary to the `feePayer`.

#### `constants` (object, optional)
A key-value store for defining reusable values that can be referenced elsewhere in the manifest. This is useful for avoiding repetition and improving readability.

#### `invocations` (array of objects, required)
An array of one or more `Invocation` objects, each representing a specific action to be executed. The invocations are executed sequentially.

#### `resultSchema` (object, optional)
An object that provides a schema for decoding a binary `execution_result` (as defined in LIP-0014) into a human-readable JavaScript object. This is used by the `lea-ltm decode-result` command.

The schema is organized by `program_id`. Each key in the `resultSchema` object is a program address that can be a constant reference (e.g., `$const(myContract)`) or a Bech32m string. The value is an object that maps the desired output field names to their corresponding type and numeric key.

The format for the mapping is: `"outputFieldName": "type(numeric_key)"`
- **Supported types:** `uleb`, `sleb`, `vector`.
- **`numeric_key`**: The integer key from the execution result stream.

**Example:**
```json
"constants": {
  "tokenContract": "lea1..."
},
"resultSchema": {
  "$const(tokenContract)": {
    "newBalance": "uleb(0)",
    "recipientAddress": "vector(1)"
  }
}
```
When decoding, the tool will look for a result from `tokenContract` with key `0`, parse it as a `ULEB` value (which becomes a JavaScript `BigInt`), and assign it to the `newBalance` field. It will do the same for key `1` as a `vector` (which becomes a `Uint8Array`).

---

## The `Invocation` Object

Each object in the `invocations` array defines a target and a set of instructions.

| Field           | Type    | Description                               |
| --------------- | ------- | ----------------------------------------- |
| `targetAddress` | string  | The address of the account or contract to execute. |
| `instructions`  | array   | A list of instruction objects to be executed. |

### `instructions`
The `instructions` array contains a sequence of objects, where each object represents a single data item to be passed to the target. The key of the object defines the data type according to the **Simple Compact Transaction Protocol (SCTP)**.

**Example Instructions:**
```json
"instructions": [
  { "uleb": 1 },
  { "uint64": "1000000" },
  { "vector": "aabbccddeeff" },
  { "uint8": "$addr(someAccount)" }
]
```

### The `INLINE` Pseudo-Instruction
In addition to the standard SCTP types, a special pseudo-instruction `INLINE` is supported. This allows for the direct injection of a pre-encoded raw byte stream into the transaction. Its value must be a `Uint8Array`, which is typically provided by another directive like `$pubset`.

This is an advanced feature used for cases where the instruction data is not a single, simple type.

**Example:**
```json
"instructions": [
  { "uleb": 123 },
  { "INLINE": "$pubset(identityOwner)" }
]
```

---

## Dynamic Values (Variables)

To create flexible and reusable manifests, LTM supports special string-based variables that are resolved at processing time.

### `$const(variableName)`
Substitutes the value of a variable defined in the top-level `constants` object.

**Example:**
```json
"constants": {
  "transferAmount": "5000"
},
"invocations": [{
  "instructions": [
    { "uint64": "$const(transferAmount)" }
  ]
}]
```

### `$addr(addressReference)`
Resolves to a 32-byte raw address. The reference inside the parentheses can be one of two things:
1.  **A Logical Name**: The name of a signer (e.g., `feePayer` or a name from the `signers` array) or a named constant.
2.  **A Bech32m String**: A standard `lea...` address string.

**Example:**
```json
"constants": {
  "contract": "lea1..."
},
"feePayer": "sender",
"invocations": [{
  "targetAddress": "$addr(contract)",
  "instructions": [
    { "uint8": "$addr(sender)" },
    { "uint8": "$addr(lea1y54smzd2dvvgujg9h209kss7us898024elna8rutjxraaxc3cz8qcvujl2)" }
  ]
}]
```
In this example, `$addr(contract)` resolves the constant, `$addr(sender)` resolves the `feePayer`'s address, and the final instruction resolves the literal Bech32m address.

### `$pubset(signerName)`
Resolves to a raw SCTP-encoded byte stream representing the public key set of the specified signer. This is primarily used with the `INLINE` instruction type to embed a signer's identity directly into a transaction, which is useful for on-chain verification.

The byte stream consists of a sequence of SCTP fields: a `SHORT` marker (0 for Ed25519, 1 for Falcon-512) followed by a `VECTOR` containing the public key.

**Example:**
```json
"invocations": [{
  "instructions": [
    { "INLINE": "$pubset(identityOwner)" }
  ]
}]
```
