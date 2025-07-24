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
