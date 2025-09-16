import { createBLAKE3 } from 'hash-wasm';

// "TX-LINK-V1" in ASCII is 10 bytes. Pad to a fixed 32-byte domain separator.
export const DOMAIN_TX_LINK_V1 = new Uint8Array([
    0x54, 0x58, 0x2D, 0x4C, 0x49, 0x4E, 0x4B, 0x2D, 0x56, 0x31, // "TX-LINK-V1"
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // padding
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // padding
    0x00, 0x00
]);

export async function computeTxLinkHash(oldHash, newHash) {
    if (!(oldHash instanceof Uint8Array) || oldHash.length !== 32) {
        throw new Error('oldHash must be a 32-byte Uint8Array');
    }
    if (!(newHash instanceof Uint8Array) || newHash.length !== 32) {
        throw new Error('newHash must be a 32-byte Uint8Array');
    }
    const blake3 = await createBLAKE3();
    blake3.init();
    blake3.update(DOMAIN_TX_LINK_V1);
    blake3.update(oldHash);
    blake3.update(newHash);
    return blake3.digest('binary');
}

