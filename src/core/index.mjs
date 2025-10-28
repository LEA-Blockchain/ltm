import { PkmiCryptoHandler, verifyEd25519, verifyFalcon512 } from './pkmiCryptoHandler.mjs';
import { resolveManifest } from './manifestResolver.mjs';
import { encodePreSignaturePayload, appendSignatures } from './transactionEncoder.mjs';
import { decodeExecutionResult } from './resultDecoder.mjs';
import { decodeTransaction } from './transactionDecoder.mjs';
import { createBLAKE3 } from 'hash-wasm';
import { computeTxLinkHash } from './txLink.mjs';
import { MsctpEncoder } from '../../msctp/msctp.js';

function toHexString(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

export { decodeExecutionResult, resolveManifest, decodeTransaction };

function normalizeKeyset(keyset) {
    if (!keyset || typeof keyset !== 'object') {
        throw new TypeError('keyset must be an object or keyset array.');
    }

    if (Array.isArray(keyset)) {
        const [ed, fal] = keyset;
        if (!Array.isArray(ed) || !Array.isArray(fal)) {
            throw new TypeError('keyset array must be [[edSk, edPk], [falSk, falPk]].');
        }
        const [, edPk] = ed;
        const [, falPk] = fal;
        return {
            ed25519: Uint8Array.from(edPk ?? []),
            falcon512: Uint8Array.from(falPk ?? [])
        };
    }

    if (keyset.ed25519?.pk && keyset.falcon512?.pk) {
        return {
            ed25519: keyset.ed25519.pk instanceof Uint8Array ? keyset.ed25519.pk : Uint8Array.from(keyset.ed25519.pk),
            falcon512: keyset.falcon512.pk instanceof Uint8Array ? keyset.falcon512.pk : Uint8Array.from(keyset.falcon512.pk)
        };
    }

    if (keyset.keyset) {
        return normalizeKeyset(keyset.keyset);
    }

    throw new TypeError('Unsupported keyset format. Expected {ed25519:{pk}, falcon512:{pk}} or [[sk, pk], ...].');
}

export async function verifyTransactionWithKeyset(input, keyset, options = {}) {
    let decoded;
    let txBytes = null;

    if (input instanceof Uint8Array) {
        txBytes = input;
        const { stripVmHeader = false } = options;
        decoded = decodeTransaction(txBytes, { stripVmHeader });
    } else if (input && typeof input === 'object' && Array.isArray(input.invocations)) {
        decoded = input;
    } else {
        throw new TypeError('verifyTransactionWithKeyset expects transaction bytes or a decoded transaction object.');
    }
    if (decoded.signatures.length !== 1) {
        throw new Error(`Expected exactly one signature pair, found ${decoded.signatures.length}.`);
    }

    if (!decoded.hashes?.base) {
        if (txBytes) {
            // Recompute by decoding again to ensure hashes populated.
            decoded = decodeTransaction(txBytes, options);
        } else {
            throw new Error('Decoded transaction does not expose hash helpers.');
        }
        if (!decoded.hashes?.base) {
            throw new Error('Unable to compute transaction hash for verification.');
        }
    }

    const message = await decoded.hashes.base();
    const { ed25519, falcon512 } = normalizeKeyset(keyset);

    const signaturePair = decoded.signatures[0];
    const edOk = await verifyEd25519(message, signaturePair.ed25519, ed25519);
    const falOk = await verifyFalcon512(message, signaturePair.falcon512, falcon512);

    return {
        ok: edOk && falOk,
        ed25519: edOk,
        falcon512: falOk
    };
}

export async function createTransaction(manifest, signerKeys, options = {}) {
    // 1. Initialize crypto handlers for all provided signers.
    const addressToHandlerMap = new Map();
    manifest.signers = {};
    for (const signerName in signerKeys) {
        const handler = new PkmiCryptoHandler();
        await handler.init();
        await handler.loadKeysetFromObject(signerKeys[signerName]);
        const address = handler.address.raw;
        addressToHandlerMap.set(address.toString('hex'), handler);
        manifest.signers[signerName] = handler;
    }

    // 2. Resolve the manifest into a canonical, machine-readable format.
    const resolvedManifest = await resolveManifest(manifest);
    const { pod, addresses: finalAddressList } = resolvedManifest;

    // 3. Encode the pre-signature payload using MSCTP.
    const sctpEncoder = new MsctpEncoder();
    encodePreSignaturePayload(sctpEncoder, resolvedManifest);

    // This is a temporary step. The `build()` method in MsctpEncoder returns the final buffer,
    // but we need the intermediate bytes for hashing. We'll build it here and then
    // re-use the chunks to build the final payload later.
    const preSigPayloadBytes = sctpEncoder.build();

    // 4. Calculate the base transaction hash.
    // The base hash is computed over: blake3(pod + sctp_pre_signature_payload)
    const hasher = await createBLAKE3();
    hasher.init();
    hasher.update(pod);
    hasher.update(preSigPayloadBytes);
    const txHash = hasher.digest('binary');

    const txId = toHexString(txHash);
    console.log(`[INFO] Base Transaction Hash: ${txId}`);

    // Optional chaining: if a previous hash is provided, validate it strictly.
    // If valid and non-zero, compute a domain-separated link hash and sign that.
    // If omitted/undefined, sign the base tx hash.
    let messageToSign = txHash;
    let linkId = null;

    const hasPrevOption = options && Object.prototype.hasOwnProperty.call(options, 'prevTxHash');
    const prev = hasPrevOption ? options.prevTxHash : undefined;

    if (prev !== undefined) {
        if (!(prev instanceof Uint8Array) || prev.length !== 32) {
            throw new Error('options.prevTxHash must be a 32-byte Uint8Array');
        }
        const prevHex = toHexString(prev);
        if (!isAllZero(prev)) {
            console.log(`[INFO] prevTxHash provided (used for chaining): ${prevHex}`);
            const linkHash = await computeTxLinkHash(prev, txHash);
            linkId = toHexString(linkHash);
            console.log(`[INFO] Link Hash (for signing): ${linkId}`);
            messageToSign = linkHash;
        } else {
            console.warn(`[WARN] prevTxHash provided but all zeros (${prevHex}); skipping chaining and signing base tx hash.`);
        }
    } else {
        console.log('[INFO] No prevTxHash provided; signing base tx hash.');
    }

    // 5. Generate signatures from all required signers.
    const signatures = [];
    const signerCount = finalAddressList.length - (finalAddressList.length - Object.keys(manifest.signers).length);
    for (let i = 0; i < signerCount; i++) {
        const signerAddress = finalAddressList[i];
        const handler = addressToHandlerMap.get(signerAddress.toString('hex'));
        if (!handler) {
            throw new Error(`[ERROR] Logic error: Could not find a handler for signing address: ${signerAddress.toString('hex')}`);
        }
        const signaturePair = await handler.signMessage(messageToSign);
        signatures.push(signaturePair);
    }

    // 6. Append the signatures to the SCTP payload.
    appendSignatures(sctpEncoder, signatures);
    const finalSctpPayload = sctpEncoder.build();

    // 7. Assemble the final transaction: pod_prefix + final_sctp_payload
    const tx = new Uint8Array(pod.length + finalSctpPayload.length);
    tx.set(pod, 0);
    tx.set(finalSctpPayload, pod.length);

    return { tx, txId, linkId };
}

function isAllZero(arr) {
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] !== 0) return false;
    }
    return true;
}
