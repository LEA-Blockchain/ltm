import { decode } from './bech32m.mjs';

// --- UTILITY FUNCTIONS ---

function hexToBytes(hex) {
  if (typeof hex !== 'string') {
    throw new TypeError('hexToBytes: expected string, got ' + typeof hex);
  }
  if (hex.startsWith('0x')) {
      hex = hex.slice(2);
  }
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const j = i * 2;
    bytes[i] = parseInt(hex.slice(j, j + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
    return bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
}

function compareByteArrays(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) {
            return a[i] - b[i];
        }
    }
    return a.length - b.length;
}

function decodeAddress(addressStr) {
    if (addressStr.startsWith('lea1')) {
        return decode('lea', addressStr);
    }
    return hexToBytes(addressStr);
}


// --- RESOLVER PASSES ---

function _resolveConstants(obj, constants) {
    if (obj instanceof Uint8Array) {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(item => _resolveConstants(item, constants));
    }
    if (typeof obj === 'object' && obj !== null) {
        const newObj = {};
        for (const [key, val] of Object.entries(obj)) {
            if (key === 'signers') {
                newObj[key] = val;
            } else {
                newObj[key] = _resolveConstants(val, constants);
            }
        }
        return newObj;
    }
    if (typeof obj === 'string') {
        return obj.replace(/\$const\(([^)]+)\)/g, (match, key) => {
            if (constants[key] === undefined) throw new Error(`Constant '${key}' not found.`);
            return _resolveConstants(constants[key], constants);
        });
    }
    return obj;
}

function _buildAliasMap(signers, constants) {
    const aliasMap = new Map();
    if (signers) {
        for (const [name, signer] of Object.entries(signers)) {
            aliasMap.set(name, signer.address.bech32m);
        }
    }
    if (constants) {
        for (const [name, value] of Object.entries(constants)) {
            aliasMap.set(name, value);
        }
    }
    return aliasMap;
}

function _collectLiteralAddressStrings(obj, aliasMap, addressSet) {
    if (Array.isArray(obj)) {
        obj.forEach(item => _collectLiteralAddressStrings(item, aliasMap, addressSet));
        return;
    }
    if (typeof obj === 'object' && obj !== null) {
        for (const val of Object.values(obj)) {
            _collectLiteralAddressStrings(val, aliasMap, addressSet);
        }
        return;
    }
    if (typeof obj === 'string') {
        const addrMatch = obj.match(/^\$addr\((.+)\)$/);
        if (addrMatch) {
            const key = addrMatch[1];
            const literalAddress = aliasMap.get(key) || key;
            addressSet.add(literalAddress);
        }
    }
}

function _createCanonicalAddressListAndIndexMap(literalAddressSet, constResolvedManifest, originalSigners) {
    const feePayerAlias = constResolvedManifest.feePayer;
    const hasSigners = Object.keys(originalSigners).length > 0;

    // For unsigned transactions, the address list is based only on non-signer addresses.
    if (!hasSigners) {
        const nonSignerLiterals = [...literalAddressSet];
        const nonSignerBytes = nonSignerLiterals.map(decodeAddress).sort(compareByteArrays);
        
        const literalAddressIndexMap = new Map();
        const addressMapByHex = new Map(nonSignerBytes.map((bytes, i) => [bytesToHex(bytes), i]));

        for (const literalAddress of literalAddressSet) {
            const hex = bytesToHex(decodeAddress(literalAddress));
            const index = addressMapByHex.get(hex);
            if (index !== undefined) {
                literalAddressIndexMap.set(literalAddress, index);
            }
        }
        return { finalAddressList: nonSignerBytes, literalAddressIndexMap };
    }
    
    // For signed transactions, a feePayer is mandatory.
    if (!feePayerAlias) throw new Error("Signed manifest must have a 'feePayer' field.");
    
    const feePayerSigner = originalSigners[feePayerAlias];
    if (!feePayerSigner) throw new Error(`Fee payer '${feePayerAlias}' not found in signers object.`);
    
    const feePayerLiteralAddress = feePayerSigner.address.bech32m;
    const feePayerBytes = feePayerSigner.address.raw;

    const signerLiteralAddresses = new Set(Object.values(originalSigners).map(s => s.address.bech32m));

    const otherSignerLiterals = [...signerLiteralAddresses].filter(addr => addr !== feePayerLiteralAddress);
    const otherSignerBytes = otherSignerLiterals.map(decodeAddress).sort(compareByteArrays);

    const nonSignerLiterals = [...literalAddressSet].filter(addr => !signerLiteralAddresses.has(addr));
    const nonSignerBytes = nonSignerLiterals.map(decodeAddress).sort(compareByteArrays);

    const finalAddressListBytes = [feePayerBytes, ...otherSignerBytes, ...nonSignerBytes];

    const literalAddressIndexMap = new Map();
    const addressMapByHex = new Map(finalAddressListBytes.map((bytes, i) => [bytesToHex(bytes), i]));

    const allKnownLiterals = new Set([...literalAddressSet, ...signerLiteralAddresses]);
    for (const literalAddress of allKnownLiterals) {
        const hex = bytesToHex(decodeAddress(literalAddress));
        const index = addressMapByHex.get(hex);
        if (index !== undefined) {
            literalAddressIndexMap.set(literalAddress, index);
        }
    }
    
    return { finalAddressList: finalAddressListBytes, literalAddressIndexMap };
}

function _resolveToIndices(obj, aliasMap, literalAddressIndexMap) {
    if (obj instanceof Uint8Array) {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(item => _resolveToIndices(item, aliasMap, literalAddressIndexMap));
    }
    if (typeof obj === 'object' && obj !== null) {
        const newObj = {};
        for (const [key, val] of Object.entries(obj)) {
            newObj[key] = _resolveToIndices(val, aliasMap, literalAddressIndexMap);
        }
        return newObj;
    }
    if (typeof obj === 'string') {
        const addrMatch = obj.match(/^\$addr\((.+)\)$/);
        if (addrMatch) {
            const key = addrMatch[1];
            const literalAddress = aliasMap.get(key) || key;
            const index = literalAddressIndexMap.get(literalAddress);
            if (index === undefined) {
                 throw new Error(`Logic error: Could not find final index for address: ${literalAddress}`);
            }
            return index;
        }
    }
    return obj;
}


const PUBSET_REGEX = /^\$pubset\(([^)]+)\)$/;

async function _resolvePubsets(obj, signers) {
    if (obj instanceof Uint8Array) {
        return obj;
    }
    if (Array.isArray(obj)) {
        return await Promise.all(obj.map(item => _resolvePubsets(item, signers)));
    }
    if (typeof obj === 'object' && obj !== null) {
        const newObj = {};
        for (const [key, val] of Object.entries(obj)) {
            newObj[key] = await _resolvePubsets(val, signers);
        }
        return newObj;
    }
    if (typeof obj === 'string') {
        const pubsetMatch = obj.match(PUBSET_REGEX);
        if (pubsetMatch) {
            const signerName = pubsetMatch[1];
            const signer = signers[signerName];
            if (!signer) {
                throw new Error(`Signer '${signerName}' referenced in $pubset not found.`);
            }
            return await signer.pubset();
        }
    }
    return obj;
}


// --- MAIN EXPORT ---

export async function resolveManifest(input) {
    const { pod, constants = {}, signers = {}, ...template } = input;

    const podBytes = pod ? decodeAddress(pod) : new Uint8Array(32).fill(0x11);
    if (podBytes.length !== 32) {
        throw new Error(`Pod must be a 32-byte address, but got ${podBytes.length} bytes.`);
    }

    // Pass 1: Resolve all constants throughout the template.
    const constResolvedManifest = _resolveConstants(template, constants);

    // Pass 1.5: Resolve all pubset directives.
    const pubsetResolvedManifest = await _resolvePubsets(constResolvedManifest, signers);

    // Pass 2: Build a map of all known aliases to their literal address strings.
    const aliasMap = _buildAliasMap(signers, constants);
    
    // Pass 3: Collect all unique literal address strings from the constant-resolved manifest.
    const literalAddressSet = new Set();
    _collectLiteralAddressStrings(pubsetResolvedManifest, aliasMap, literalAddressSet);

    // Pass 4: Build the canonical address list and the final index map.
    const { finalAddressList, literalAddressIndexMap } = _createCanonicalAddressListAndIndexMap(
        literalAddressSet,
        pubsetResolvedManifest,
        signers
    );

    // Pass 5: Resolve the manifest body to its final indexed form.
    const resolvedBody = _resolveToIndices(pubsetResolvedManifest, aliasMap, literalAddressIndexMap);

    const resolvedManifest = {
        pod: podBytes,
        version: template.version,
        sequence: template.sequence,
        gasLimit: template.gasLimit,
        gasPrice: template.gasPrice,
        invocations: resolvedBody.invocations,
        signers: signers,
        addresses: finalAddressList,
        // Expose maps for tooling
        _maps: {
            alias: aliasMap,
            literal: literalAddressIndexMap
        }
    };

    // The fee payer is always index 0 for signed transactions.
    if (Object.keys(signers).length > 0) {
        resolvedManifest.feePayer = 0;
    }

    return resolvedManifest;
}