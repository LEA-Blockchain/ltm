// config.mjs

// The Human-Readable Part (HRP) for bech32m-encoded addresses.
export const ADDRESS_HRP = 'lea';

// As per LIP-7, the total decoded size of a transaction must not exceed 1MB.
const MAX_TRANSACTION_SIZE = 1024 * 1024;

// We initialize encoder buffers to half the maximum allowed transaction size
// to ensure there is ample room for data without causing an allocation
// error in the underlying WASM module. This value is used for both the main
// transaction encoder and the nested instruction encoder.
export const ENCODER_INIT_SIZE = MAX_TRANSACTION_SIZE / 2; // 512KB
