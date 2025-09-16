'use strict';

// --- Constants ---
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
/** @type {number[]} */
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3; // Using Bech32m checksum constant

// --- Configuration for Your Blockchain (ADJUST THESE!) ---
/** Represents the data type or version being encoded. */
const DATA_VERSION_BYTE = null; // Set to null if no version byte needed
/** Minimum allowed length in bytes for the data being encoded (e.g., public key). */
const MIN_DATA_LENGTH_BYTES = 16; // <<< ADJUSTED FOR 32-byte PUBLIC KEY
/** Maximum allowed length in bytes for the data being encoded (e.g., public key). */
const MAX_DATA_LENGTH_BYTES = 64; // <<< ADJUSTED FOR 64-byte PUBLIC KEY

// BIP-173 constants (generally stay the same)
const MAX_BECH32_LENGTH = 200; // MODIFIED from 90 to support 64-byte data
const MIN_HRP_LENGTH = 1;
const MAX_HRP_LENGTH = 83;
const CHECKSUM_LENGTH = 6;
// Minimum Bech32 string length depends on HRP, version byte presence, and min data length
const MIN_BECH32_LENGTH = MIN_HRP_LENGTH + 1 /*sep*/ + (DATA_VERSION_BYTE !== null ? 1 : 0) + Math.ceil(MIN_DATA_LENGTH_BYTES * 8 / 5) + CHECKSUM_LENGTH;


// --- Precomputed Character Lookup Map ---
/** @type {Record<string, number>} */
const CHAR_MAP = {};
for (let i = 0; i < CHARSET.length; i++) {
    const char = CHARSET[i];
    // Add type assertion or check to satisfy TS2538
    if (char === undefined) continue; // Should theoretically not happen
    CHAR_MAP[char] = i;
}

// --- Internal Helper Functions ---

/**
 * @private Calculates the polynomial modulus.
 * @param {Array<number>} values - Array of 5-bit values.
 * @returns {number} The polymod checksum state.
 */
function polymod(values) {
    let checksumState = 1;
    for (let index = 0; index < values.length; ++index) {
        const value = values[index];
        if (value === undefined) continue; // Added check
        const top = checksumState >> 25;
        checksumState = (checksumState & 0x1ffffff) << 5 ^ value;
        for (let i = 0; i < 5; ++i) {
            // Check added implicitly by typing GENERATOR as number[]
            // Explicit check added to satisfy TS2532
            const genValue = GENERATOR[i];
            if (((top >> i) & 1) && genValue !== undefined) { // <<< EXPLICIT CHECK HERE
                checksumState ^= genValue;
            }
        }
    }
    return checksumState;
}

/**
 * @private Expands the HRP for checksum calculation.
 * @param {string} hrp - The human-readable part.
 * @returns {Array<number>} Expanded HRP values.
 */
function hrpExpand(hrp) {
    const expanded = new Array(hrp.length * 2 + 1);
    let i = 0;
    for (let index = 0; index < hrp.length; ++index) expanded[i++] = hrp.charCodeAt(index) >> 5;
    expanded[i++] = 0;
    for (let index = 0; index < hrp.length; ++index) expanded[i++] = hrp.charCodeAt(index) & 31;
    return expanded;
}

/**
 * @private Verifies the BECH32M checksum.
 * @param {string} hrp - The human-readable part.
 * @param {Array<number>} dataWithChecksum - 5-bit data including checksum.
 * @returns {boolean} True if checksum is valid.
 */
function verifyChecksum(hrp, dataWithChecksum) {
    const expandedHrp = hrpExpand(hrp);
    const combined = new Array(expandedHrp.length + dataWithChecksum.length);
    let k = 0;
    for (let i = 0; i < expandedHrp.length; i++) combined[k++] = expandedHrp[i];
    for (let i = 0; i < dataWithChecksum.length; i++) combined[k++] = dataWithChecksum[i];
    return polymod(combined) === BECH32M_CONST;
}

/**
 * @private Creates the BECH32M checksum.
 * @param {string} hrp - The human-readable part.
 * @param {Array<number>} data5bitWithVersion - 5-bit data (potentially including version byte).
 * @returns {Array<number>} The 6-element checksum array.
 */
function createChecksum(hrp, data5bitWithVersion) {
    const expandedHrp = hrpExpand(hrp);
    const values = new Array(expandedHrp.length + data5bitWithVersion.length + CHECKSUM_LENGTH);
    let k = 0;
    for (let i = 0; i < expandedHrp.length; i++) values[k++] = expandedHrp[i];
    for (let i = 0; i < data5bitWithVersion.length; i++) values[k++] = data5bitWithVersion[i];
    for (let i = 0; i < CHECKSUM_LENGTH; i++) values[k++] = 0; // Checksum placeholder

    const mod = polymod(values) ^ BECH32M_CONST;
    const checksum = new Array(CHECKSUM_LENGTH);
    for (let i = 0; i < CHECKSUM_LENGTH; ++i) {
        checksum[i] = (mod >> 5 * (CHECKSUM_LENGTH - 1 - i)) & 31;
    }
    return checksum;
}

/**
 * @private Converts bits from one base to another.
 * @param {Array<number> | Uint8Array} inputData - Data to convert.
 * @param {number} frombits - Input bit size (e.g., 8).
 * @param {number} tobits - Output bit size (e.g., 5).
 * @param {boolean} pad - Whether to pad output.
 * @returns {Array<number>} Converted data.
 * @throws {Error} If input values or padding are invalid.
 */
function convertbits(inputData, frombits, tobits, pad) {
    let acc = 0;
    let bits = 0;
    const ret = [];
    const maxv = (1 << tobits) - 1;
    const max_acc = (1 << (frombits + tobits - 1)) - 1;

    for (let index = 0; index < inputData.length; ++index) {
        const value = inputData[index];
        if (value === undefined || value < 0 || (value >> frombits) !== 0) {
            throw new Error(`Invalid value in convertbits: ${value}`);
        }
        acc = ((acc << frombits) | value) & max_acc;
        bits += frombits;
        while (bits >= tobits) {
            bits -= tobits;
            ret.push((acc >> bits) & maxv);
        }
    }

    if (pad) {
        if (bits > 0) {
            ret.push((acc << (tobits - bits)) & maxv);
        }
    } else if (bits >= frombits || ((acc << (tobits - bits)) & maxv)) {
        throw new Error("Invalid padding/conversion in convertbits");
    }
    return ret;
}

/**
 * @private Internal: Encodes HRP and 5-bit data (optionally prepends version).
 * @param {string} hrp - The human-readable part.
 * @param {Array<number>} data5bit - 5-bit data array.
 * @returns {string} Encoded Bech32m string.
 */
function _encodeBech32mData(hrp, data5bit) {
    // Prepend version byte if configured
    const data5bitWithVersion = (DATA_VERSION_BYTE !== null)
        ? [DATA_VERSION_BYTE, ...data5bit]
        : [...data5bit];

    const checksum = createChecksum(hrp, data5bitWithVersion);

    const combined = new Array(data5bitWithVersion.length + checksum.length);
    let k = 0;
    for (let i = 0; i < data5bitWithVersion.length; i++) combined[k++] = data5bitWithVersion[i];
    for (let i = 0; i < checksum.length; i++) combined[k++] = checksum[i];

    let ret = hrp + '1';
    for (let index = 0; index < combined.length; ++index) {
        const charIndex = combined[index];
        if (charIndex === undefined) throw new Error("Undefined index in combined data"); // Added check
        ret += CHARSET.charAt(charIndex);
    }
    return ret;
}

/**
 * @private Internal: Decodes and validates BECH32M string (syntax, checksum, version).
 * @param {string} bechString - The Bech32m string.
 * @returns {{ hrp: string; data5bitWithVersionAndChecksum: Array<number>; version: number | null }} Decoded parts.
 * @throws {Error} If string is invalid.
 */
function _decodeBech32mDataAndValidate(bechString) {
    if (typeof bechString !== 'string') throw new Error("Input must be a string.");

    let has_lower = false, has_upper = false;
    for (let index = 0; index < bechString.length; ++index) {
        const charCode = bechString.charCodeAt(index);
        if (charCode < 33 || charCode > 126) throw new Error(`Invalid character: ${bechString[index]}`);
        if (charCode >= 97 && charCode <= 122) has_lower = true;
        else if (charCode >= 65 && charCode <= 90) has_upper = true;
    }
    if (has_lower && has_upper) throw new Error("Mixed case detected.");

    const lowerBechString = bechString.toLowerCase();
    const sepPos = lowerBechString.lastIndexOf('1');

    // Use calculated MIN_BECH32_LENGTH
    if (sepPos < MIN_HRP_LENGTH || sepPos + 1 + CHECKSUM_LENGTH > lowerBechString.length ||
        lowerBechString.length > MAX_BECH32_LENGTH || lowerBechString.length < MIN_BECH32_LENGTH) {
        throw new Error(`Invalid structure or length (min: ${MIN_BECH32_LENGTH}, max: ${MAX_BECH32_LENGTH}, got: ${lowerBechString.length})`);
    }

    const hrp = lowerBechString.substring(0, sepPos);
    const data5bitWithVersionAndChecksum = [];
    for (let index = sepPos + 1; index < lowerBechString.length; ++index) {
        const char = lowerBechString.charAt(index);
        const charValue = CHAR_MAP[char]; // Uses typed CHAR_MAP
        if (charValue === undefined) throw new Error(`Invalid data character: ${char}`);
        data5bitWithVersionAndChecksum.push(charValue);
    }

    if (!verifyChecksum(hrp, data5bitWithVersionAndChecksum)) {
        throw new Error("Checksum verification failed.");
    }

    // Check minimum length for encoded data part
    const expectedMinDataPartLen = (DATA_VERSION_BYTE !== null ? 1 : 0) + Math.ceil(MIN_DATA_LENGTH_BYTES * 8 / 5) + CHECKSUM_LENGTH;
    if (data5bitWithVersionAndChecksum.length < expectedMinDataPartLen) {
        throw new Error(`Decoded data part too short (${data5bitWithVersionAndChecksum.length} < ${expectedMinDataPartLen}).`);
    }

    /** @type {number | null} */
    let version = null;
    if (DATA_VERSION_BYTE !== null) {
        // Explicitly handle potential undefined from array access before assigning to 'version'
        const firstVal = data5bitWithVersionAndChecksum[0];
        version = (firstVal === undefined) ? null : firstVal; // <<< FIX HERE: Assign null if undefined

        if (version === null || version !== DATA_VERSION_BYTE) { // <<< FIX HERE: Check against null
            throw new Error(`Unsupported version: expected ${DATA_VERSION_BYTE}, got ${version}`);
        }
    }

    return { hrp: hrp, data5bitWithVersionAndChecksum: data5bitWithVersionAndChecksum, version: version };
}

// --- Exported Functions ---

/**
 * Decodes a BECH32M string into its HRP and data bytes.
 * Throws an error if the address is invalid, has the wrong HRP, or fails validation.
 *
 * @param {string} expectedHrp - The expected human-readable part.
 * @param {string} bech32mString - The BECH32M address string.
 * @returns {Uint8Array} The decoded 8-bit data bytes.
 * @throws {Error} If decoding fails or validation checks do not pass.
 * @export
 */
export function decode(expectedHrp, bech32mString) {
    const decodedParts = _decodeBech32mDataAndValidate(bech32mString);

    if (decodedParts.hrp !== expectedHrp) {
        throw new Error(`Mismatched HRP: expected '${expectedHrp}', got '${decodedParts.hrp}'`);
    }

    // Determine where the actual data starts (after version byte, if any) and ends (before checksum)
    const dataStartIndex = (DATA_VERSION_BYTE !== null) ? 1 : 0;
    const dataEndIndex = decodedParts.data5bitWithVersionAndChecksum.length - CHECKSUM_LENGTH;

    const data5bit = decodedParts.data5bitWithVersionAndChecksum.slice(dataStartIndex, dataEndIndex);
    const dataBytes = convertbits(data5bit, 5, 8, false); // Throws on error

    // Validate decoded data length against configured limits
    if (dataBytes.length < MIN_DATA_LENGTH_BYTES || dataBytes.length > MAX_DATA_LENGTH_BYTES) {
        throw new Error(`Invalid decoded data length: ${dataBytes.length} bytes (must be between ${MIN_DATA_LENGTH_BYTES} and ${MAX_DATA_LENGTH_BYTES})`);
    }

    return new Uint8Array(dataBytes);
}

/**
 * Encodes HRP and data bytes into a BECH32M string.
 * Throws an error if inputs are invalid.
 *
 * @param {string} hrp - The human-readable part (lowercase, 1-83 chars).
 * @param {Uint8Array | Array<number>} dataBytes - The data to encode (array of 8-bit values). Length must be within configured min/max.
 * @returns {string} The encoded BECH32M string.
 * @throws {Error} If inputs are invalid (HRP, dataBytes) or encoding fails.
 * @export
 */
export function encode(hrp, dataBytes) {
    // HRP validation
    if (typeof hrp !== 'string' || hrp.length < MIN_HRP_LENGTH || hrp.length > MAX_HRP_LENGTH) {
        throw new Error(`Invalid HRP length: ${hrp?.length}`);
    }
    for (let i = 0; i < hrp.length; ++i) {
        const charCode = hrp.charCodeAt(i);
        if (charCode < 33 || charCode > 126) throw new Error(`Invalid HRP character code: ${charCode}`);
        if (charCode >= 65 && charCode <= 90) throw new Error(`Invalid HRP character case: ${hrp[i]}`);
    }

    // Data validation (type, length, content)
    if (!dataBytes || typeof dataBytes.length !== 'number') throw new Error("Invalid dataBytes type.");
    if (dataBytes.length < MIN_DATA_LENGTH_BYTES || dataBytes.length > MAX_DATA_LENGTH_BYTES) {
        throw new Error(`Invalid dataBytes length: ${dataBytes.length} (must be between ${MIN_DATA_LENGTH_BYTES} and ${MAX_DATA_LENGTH_BYTES})`);
    }
    // Check elements are valid bytes
    const dataBytesArray = (dataBytes instanceof Uint8Array) ? dataBytes : Uint8Array.from(dataBytes);
    for (let i = 0; i < dataBytesArray.length; ++i) {
        const byte = dataBytesArray[i];
        if (byte === undefined || typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
            throw new Error(`Invalid data byte at index ${i}: ${byte}`);
        }
    }


    const data5bit = convertbits(dataBytesArray, 8, 5, true); // Throws on error
    const encodedString = _encodeBech32mData(hrp, data5bit);

    // Final length check safeguard
    if (encodedString.length > MAX_BECH32_LENGTH) {
        throw new Error(`Internal error: Generated string exceeds max length (${encodedString.length})`);
    }

    return encodedString;
}
