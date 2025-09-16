// msctp.js - A JavaScript implementation of the Micro-SCTP Encoding Standard.

// Error Codes (aligned with C implementation)
export const MSCTP_SUCCESS = 0;
export const MSCTP_ERR_INVALID_HEADER = -1;
export const MSCTP_ERR_INVALID_LENGTH = -2;
export const MSCTP_ERR_OVERLONG_LEB128 = -3;
export const MSCTP_ERR_MALFORMED_LEB128 = -4;
export const MSCTP_ERR_SIZE_LIMIT_EXCEEDED = -5;
export const MSCTP_ERR_NULL_POINTER = -6;
export const MSCTP_ENCODE_ERROR = -7;


/**
 * Custom error class for MSCTP parsing errors.
 */
export class MsctpError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'MsctpError';
        this.code = code;
    }
}

// Type Tags (aligned with C implementation)
export const MSCTP_TT_SLEB128 = 0x00;
export const MSCTP_TT_ULEB128 = 0x01;
export const MSCTP_TT_SMALL_VECTOR = 0x02;
export const MSCTP_TT_LARGE_VECTOR = 0x03;

// Masks (aligned with C implementation)
const MSCTP_TT_MASK = 0x03;

// Constants
const MSCTP_MAX_SMALL_VECTOR_SIZE = 63;
const MSCTP_MAX_LARGE_VECTOR_SIZE = 1048576; // 1 MiB
export const MSCTP_MAX_VECTOR_SIZE = MSCTP_MAX_LARGE_VECTOR_SIZE;

// --- Helper Functions (from C implementation) ---

function msctp_make_header(modifier, tt) {
    return (modifier << 2) | (tt & MSCTP_TT_MASK);
}

export function msctp_get_tt(header) {
    return header & MSCTP_TT_MASK;
}

function msctp_get_modifier(header) {
    return header >> 2;
}


// --- Raw LEB128 Coders (Internal) ---

function _encode_raw_uleb128(value) {
    if (value < 0n) {
        return null;
    }
    if (value === 0n) {
        return new Uint8Array([0]);
    }

    const bytes = [];
    while (value > 0n) {
        let byte = Number(value & 0x7Fn);
        value >>= 7n;
        if (value !== 0n) {
            byte |= 0x80;
        }
        bytes.push(byte);
    }
    return new Uint8Array(bytes);
}

function _decode_raw_uleb128(data) {
    let value = 0n;
    let shift = 0n;
    let i = 0;
    let byte;

    while (true) {
        if (i >= data.length) {
            throw new MsctpError("Unterminated ULEB128 sequence", MSCTP_ERR_MALFORMED_LEB128);
        }
        byte = data[i];
        i++;

        value |= BigInt(byte & 0x7f) << shift;

        if ((byte & 0x80) === 0) {
            break;
        }
        shift += 7n;
    }

    // Canonical check
    const encoded = _encode_raw_uleb128(value);
    if (encoded.length !== i) {
        throw new MsctpError("Overlong ULEB128 encoding", MSCTP_ERR_OVERLONG_LEB128);
    }

    return [value, i];
}

function _encode_raw_sleb128(value) {
    const bytes = [];
    let more = true;

    while (more) {
        let byte = Number(value & 0x7Fn);
        value >>= 7n;

        let signBit = (byte & 0x40) !== 0;

        if ((value === 0n && !signBit) || (value === -1n && signBit)) {
            more = false;
        } else {
            byte |= 0x80;
        }
        bytes.push(byte);
    }
    return new Uint8Array(bytes);
}

function _decode_raw_sleb128(data) {
  let value = 0n;
  let shift = 0n;
  let i = 0;
  let byte = 0;

  while (true) {
    if (i >= data.length) {
      throw new MsctpError("Unterminated SLEB128 sequence", MSCTP_ERR_MALFORMED_LEB128);
    }
    byte = data[i++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n; // bump on every byte, including the last
    if ((byte & 0x80) === 0) break; // last byte
  }

  // Sign-extend from the final bit-width if the sign bit in the last byte is set.
  if ((byte & 0x40) !== 0) {
    const mask = (1n << shift) - 1n;
    value = (value & mask) | (~mask);
  }

  // Canonical length check (reject overlong encodings)
  const encoded = _encode_raw_sleb128(value);
  if (encoded.length !== i) {
    throw new MsctpError("Overlong SLEB128 encoding", MSCTP_ERR_OVERLONG_LEB128);
  }

  return [value, i];
}


// --- Encoder/Decoder Classes ---

/**
 * A class for building a Uint8Array of concatenated MSCTP objects.
 */
export class MsctpEncoder {
    constructor() {
        this.chunks = [];
    }

    /**
     * Appends an SLEB128-encoded integer to the buffer.
     * @param {bigint} value The integer to encode.
     */
    addSleb128(value) {
        const payload = _encode_raw_sleb128(value);
        if (!payload) return;
        const header = msctp_make_header(0, MSCTP_TT_SLEB128);
        const chunk = new Uint8Array(1 + payload.length);
        chunk[0] = header;
        chunk.set(payload, 1);
        this.chunks.push(chunk);
    }

    /**
     * Appends a ULEB128-encoded integer to the buffer.
     * @param {bigint} value The integer to encode.
     */
    addUleb128(value) {
        const payload = _encode_raw_uleb128(value);
        if (!payload) return;
        const header = msctp_make_header(0, MSCTP_TT_ULEB128);
        const chunk = new Uint8Array(1 + payload.length);
        chunk[0] = header;
        chunk.set(payload, 1);
        this.chunks.push(chunk);
    }

    /**
     * Appends a vector (byte array) to the buffer.
     * @param {Uint8Array} data The byte array to encode as a vector.
     */
    addVector(data) {
        if (!data) return;
        const len = data.length;

        if (len <= MSCTP_MAX_SMALL_VECTOR_SIZE) {
            const chunk = new Uint8Array(1 + len);
            chunk[0] = msctp_make_header(len, MSCTP_TT_SMALL_VECTOR);
            chunk.set(data, 1);
            this.chunks.push(chunk);
        } else if (len <= MSCTP_MAX_LARGE_VECTOR_SIZE) {
            const lenPayload = _encode_raw_uleb128(BigInt(len));
            if (!lenPayload) return;
            const chunk = new Uint8Array(1 + lenPayload.length + len);
            chunk[0] = msctp_make_header(0, MSCTP_TT_LARGE_VECTOR);
            chunk.set(lenPayload, 1);
            chunk.set(data, 1 + lenPayload.length);
            this.chunks.push(chunk);
        }
    }

    /**
     * Concatenates all encoded chunks into a single Uint8Array.
     * @returns {Uint8Array} The final encoded data.
     */
    build() {
        const totalLength = this.chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }
}

/**
 * A class for parsing a Uint8Array of concatenated MSCTP objects.
 */
export class MsctpDecoder {
    /**
     * @param {Uint8Array} data The MSCTP data to decode.
     */
    constructor(data) {
        this.data = data;
        this.offset = 0;
    }

    /**
     * Checks if there is more data to read.
     * @returns {boolean} True if the cursor has not reached the end of the data.
     */
    hasNext() {
        return this.offset < this.data.length;
    }

    /**
     * Peeks at the type tag of the next MSCTP object without advancing the cursor.
     * @returns {number | null} The type tag, or null if at the end of the data.
     */
    peekType() {
        if (!this.hasNext()) {
            return null;
        }
        return msctp_get_tt(this.data[this.offset]);
    }

    /**
     * Reads the next object as an SLEB128-encoded integer.
     * @returns {bigint} The decoded integer.
     * @throws {MsctpError} If the next object is not a valid SLEB128.
     */
    readSleb128() {
        const header = this.data[this.offset];
        if (msctp_get_tt(header) !== MSCTP_TT_SLEB128 || msctp_get_modifier(header) !== 0) {
            throw new MsctpError("Invalid header for SLEB128", MSCTP_ERR_INVALID_HEADER);
        }
        const [value, bytesRead] = _decode_raw_sleb128(this.data.subarray(this.offset + 1));
        this.offset += bytesRead + 1;
        return value;
    }

    /**
     * Reads the next object as a ULEB128-encoded integer.
     * @returns {bigint} The decoded integer.
     * @throws {MsctpError} If the next object is not a valid ULEB128.
     */
    readUleb128() {
        const header = this.data[this.offset];
        if (msctp_get_tt(header) !== MSCTP_TT_ULEB128 || msctp_get_modifier(header) !== 0) {
            throw new MsctpError("Invalid header for ULEB128", MSCTP_ERR_INVALID_HEADER);
        }
        const [value, bytesRead] = _decode_raw_uleb128(this.data.subarray(this.offset + 1));
        this.offset += bytesRead + 1;
        return value;
    }

    /**
     * Reads the next object as a vector.
     * @returns {Uint8Array} The decoded vector payload.
     * @throws {MsctpError} If the next object is not a valid vector.
     */
    readVector() {
        const header = this.data[this.offset];
        const tt = msctp_get_tt(header);

        if (tt === MSCTP_TT_SMALL_VECTOR) {
            const len = msctp_get_modifier(header);
            const totalLen = 1 + len;
            if (this.data.length < this.offset + totalLen) {
                throw new MsctpError("Data buffer too small for SMALL_VECTOR length", MSCTP_ERR_INVALID_LENGTH);
            }
            const payload = this.data.subarray(this.offset + 1, this.offset + totalLen);
            this.offset += totalLen;
            return payload;
        } else if (tt === MSCTP_TT_LARGE_VECTOR) {
            if (msctp_get_modifier(header) !== 0) {
                throw new MsctpError("Invalid modifier for LARGE_VECTOR", MSCTP_ERR_INVALID_HEADER);
            }
            const [len, lenBytesRead] = _decode_raw_uleb128(this.data.subarray(this.offset + 1));
            if (len > MSCTP_MAX_LARGE_VECTOR_SIZE) {
                throw new MsctpError("LARGE_VECTOR size exceeds limit", MSCTP_ERR_SIZE_LIMIT_EXCEEDED);
            }
            const payloadOffset = 1 + lenBytesRead;
            const totalObjectSize = payloadOffset + Number(len);
            if (this.data.length < this.offset + totalObjectSize) {
                throw new MsctpError("Data buffer too small for declared LARGE_VECTOR payload size", MSCTP_ERR_INVALID_LENGTH);
            }
            const payload = this.data.subarray(this.offset + payloadOffset, this.offset + totalObjectSize);
            this.offset += totalObjectSize;
            return payload;
        } else {
            throw new MsctpError(`Invalid vector type tag: ${tt}`, MSCTP_ERR_INVALID_HEADER);
        }
    }
}