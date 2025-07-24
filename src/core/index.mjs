import { PkmiCryptoHandler } from './pkmiCryptoHandler.mjs';
import { resolveManifest } from './manifestResolver.mjs';
import { encodePreSignaturePayload, appendSignatures } from './transactionEncoder.mjs';
import { blake3 } from 'hash-wasm';
import { Encoder } from '@leachain/sctp';
import { ENCODER_INIT_SIZE } from './config.mjs';

export async function createTransaction(manifest, signerKeys) {
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

    const resolvedManifest = resolveManifest(manifest);
    const finalAddressList = resolvedManifest.addresses;
    
    const signerCount = addressToHandlerMap.size;

    const encoder = new Encoder();
    await encoder.init(ENCODER_INIT_SIZE);
    await encodePreSignaturePayload(encoder, resolvedManifest, finalAddressList);
    const transactionPayload = encoder.getBytes();
    
    const txHash = await blake3(transactionPayload);

    const signatures = [];
    for (let i = 0; i < signerCount; i++) {
        const signerAddress = finalAddressList[i];
        const handler = addressToHandlerMap.get(signerAddress.toString('hex'));
        if (!handler) {
            throw new Error(`[ERROR] Logic error: Could not find a handler for signing address: ${signerAddress.toString('hex')}`);
        }
        const signaturePair = await handler.signMessage(txHash);
        signatures.push(signaturePair);
    }

    appendSignatures(encoder, signatures);

    return encoder.build();
}