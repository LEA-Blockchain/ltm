import { createBLAKE3 } from 'hash-wasm';
import { createShim } from '@getlea/vm-shim';
import { MsctpEncoder } from '../../msctp/msctp.js';
import { encode } from './bech32m.mjs';
import { ADDRESS_HRP } from './config.mjs';
import ed25519Wasm from '../wasm/ed25519.wasm';
import falcon512Wasm from '../wasm/falcon512.wasm';

export class PkmiCryptoHandler {
    constructor() {
        this.keyset = null;
        this.ed25519 = null;
        this.falcon512 = null;
        this.addressBech32m = null;
        this.addressUint8 = null;
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;
        this.ed25519 = await this._instantiateWasm(ed25519Wasm);
        this.falcon512 = await this._instantiateWasm(falcon512Wasm);
        this.initialized = true;
    }

    static validateKeysetArray(array) {
        if (!Array.isArray(array)) throw new Error('Keyset must be an array');

        const [edSk, edPk] = array[0] || [];
        if (!Array.isArray(array[0]) || array[0].length !== 2)
            throw new Error('ed25519 keyset must be [sk, pk]');
        if (!Array.isArray(edSk) || edSk.some(n => typeof n !== 'number'))
            throw new Error('ed25519 secret key must be numbers');
        if (!Array.isArray(edPk) || edPk.some(n => typeof n !== 'number'))
            throw new Error('ed25519 public key must be numbers');

        const [falconSk, falconPk] = array[1] || [];
        if (!Array.isArray(array[1]) || array[1].length !== 2)
            throw new Error('falcon512 keyset must be [sk, pk]');
        if (!Array.isArray(falconSk) || falconSk.some(n => typeof n !== 'number'))
            throw new Error('falcon512 secret key must be numbers');
        if (!Array.isArray(falconPk) || falconPk.some(n => typeof n !== 'number'))
            throw new Error('falcon512 public key must be numbers');
    }

    static async generateAddress(keyset) {
        if (!keyset?.ed25519?.pk || !keyset?.falcon512?.pk) {
            throw new Error("Keyset must include ed25519 and falcon512 public keys");
        }
        const blake3 = await createBLAKE3();
        blake3.init();
        blake3.update(keyset.ed25519.pk);
        blake3.update(keyset.falcon512.pk);
        const addressHash = blake3.digest('binary');
        return {
            addressBech32m: encode(ADDRESS_HRP, addressHash),
            addressUint8: addressHash
        };
    }

    async loadKeysetFromObject(input) {
        // New format only: { keyset: [[ed25519Sk, ed25519Pk],[falconSk, falconPk]], address?, addressHex? }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error('Invalid key file: expected an object with a "keyset" field');
        }

        const { keyset, address: providedBech32, addressHex: providedHexRaw } = input;
        PkmiCryptoHandler.validateKeysetArray(keyset);

        const [ed25519Sk, ed25519Pk] = keyset[0];
        const [falconSk, falconPk] = keyset[1];

        const parsed = {
            ed25519: {
                sk: Uint8Array.from(ed25519Sk),
                pk: Uint8Array.from(ed25519Pk)
            },
            falcon512: {
                sk: Uint8Array.from(falconSk),
                pk: Uint8Array.from(falconPk)
            }
        };

        const address = await PkmiCryptoHandler.generateAddress(parsed);

        // If provided, validate supplied addresses against derived
        const providedHex = typeof providedHexRaw === 'string' ? providedHexRaw.toLowerCase() : undefined;
        if (providedBech32 && providedBech32.toLowerCase() !== address.addressBech32m.toLowerCase()) {
            throw new Error('Provided bech32m address does not match derived address from keys');
        }
        if (providedHex) {
            const derivedHex = Array.from(address.addressUint8).map(b => b.toString(16).padStart(2, '0')).join('');
            if (providedHex !== derivedHex) {
                throw new Error('Provided addressHex does not match derived address from keys');
            }
        }

        this.addressBech32m = address.addressBech32m;
        this.addressUint8 = address.addressUint8;
        this.keyset = { ...parsed, ...address };
        return this.keyset;
    }

    pubset() {
        if (!this.keyset) {
            throw new Error('Keyset not loaded. Cannot generate public key set.');
        }
        const encoder = new MsctpEncoder();

        // Add Ed25519 key
        encoder.addUleb128(0n); // Using ULEB128 for the key type marker
        encoder.addVector(this.keyset.ed25519.pk);

        // Add Falcon-512 key
        encoder.addUleb128(1n); // Using ULEB128 for the key type marker
        encoder.addVector(this.keyset.falcon512.pk);

        return encoder.build();
    }

    get address() {
        if (!this.addressUint8)
            throw new Error('Keyset must be loaded first');
        return {
            bech32m: this.addressBech32m,
            raw: this.addressUint8
        };
    }

    async _instantiateWasm(wasmBytes) {
        const { importObject, bindInstance, utils } = createShim();
        const { instance } = await WebAssembly.instantiate(wasmBytes, importObject);
        bindInstance(instance);
        return { instance, ...utils };
    }

    async signWith(signer, sk, message) {
        const { sign, sk_bytes, signature_bytes } = signer.instance.exports;

        if (sk_bytes() !== sk.length) throw new Error("Invalid secret key");

        const skPtr = signer.copyToWasm(sk);
        const msgPtr = signer.copyToWasm(message);
        const sigBytes = signature_bytes();
        const sigPtr = signer.malloc(sigBytes);

        const length = sign(sigPtr, msgPtr, message.length, skPtr);
        if (length < 0) throw new Error('Signing failed in WASM module');

        const signature = signer.readFromWasm(sigPtr, length);
        signer.reset();
        return signature;
    }

    async signMessage(message) {
        if (!this.initialized) throw new Error('Handler not initialized. Call init() first.');
        if (!this.keyset) throw new Error('Keyset not loaded.');

        const edSig = await this.signWith(this.ed25519, this.keyset.ed25519.sk, message);
        const falSig = await this.signWith(this.falcon512, this.keyset.falcon512.sk, message);

        return {
            ed25519: edSig,
            falcon512: falSig
        };
    }

    async verifyWith(verifier, pk, signature, message) {
        const { verify, pk_bytes, signature_bytes } = verifier.instance.exports;

        if (pk_bytes() !== pk.length) {
            throw new Error("Invalid public key");
        }

        const pkPtr = verifier.copyToWasm(pk);
        const sigPtr = verifier.copyToWasm(signature);
        const msgPtr = verifier.copyToWasm(message);

        const result = verify(sigPtr, signature.length, msgPtr, message.length, pkPtr);

        verifier.reset();

        if (result === 0) {
            return true; // valid
        } else {
            return false; // invalid
        }
    }

    async verifyMessage(message, signatures) {
        if (!this.initialized) throw new Error('Handler not initialized. Call init() first.');
        if (!this.keyset) throw new Error('Keyset not loaded.');

        const edPk = this.keyset.ed25519.pk;
        const falPk = this.keyset.falcon512.pk;

        const edResult = await this.verifyWith(this.ed25519, edPk, signatures.ed25519, message);
        const falResult = await this.verifyWith(this.falcon512, falPk, signatures.falcon512, message);

        return {
            ed25519: edResult,
            falcon512: falResult
        };
    }
}

