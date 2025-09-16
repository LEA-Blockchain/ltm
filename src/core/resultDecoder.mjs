import { resolveManifest } from './manifestResolver.mjs';
import {
    MsctpDecoder,
    MSCTP_TT_ULEB128,
    MSCTP_TT_SLEB128,
    MSCTP_TT_SMALL_VECTOR,
    MSCTP_TT_LARGE_VECTOR
} from '../../msctp/msctp.js';

function bytesToHex(bytes) {
    return bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
}

const SCHEMA_REGEX = /^(uleb|sleb|vector)\((\d+)\)$/;

/**
 * Parses the result schema from a manifest into a more efficient format for lookup.
 * @param {object} manifest - The full LTM manifest.
 * @returns {Promise<{schema: Map<string, Map<number, {name: string, type: string}>>, programAddresses: string[]}>}
 */
async function parseResultSchema(manifest) {
    if (!manifest.resultSchema) {
        return new Map();
    }

    // First, we need to resolve any $const() variables in the program_id keys.
    const fakeManifestForResolving = {
        constants: manifest.constants,
        invocations: Object.keys(manifest.resultSchema).map(programId => ({
            targetAddress: programId,
            instructions: []
        }))
    };
    const resolved = await resolveManifest(fakeManifestForResolving);

    const parsedSchema = new Map();
    for (const programIdKey in manifest.resultSchema) {
        const match = programIdKey.match(/\(([^)]+)\)/);
        const alias = match ? match[1] : programIdKey;
        
        let literalAddress = resolved._maps.alias.get(alias) || alias;
        
        const literalMatch = literalAddress.match(/\(([^)]+)\)/);
        if (literalMatch) {
            literalAddress = literalMatch[1];
        }

        const addressIndex = resolved._maps.literal.get(literalAddress);
        
        if (addressIndex === undefined) {
            console.warn(`[WARN] Could not resolve address for schema key: ${programIdKey}`);
            continue;
        }
        const programIdHex = bytesToHex(resolved.addresses[addressIndex]);

        const fieldMap = new Map();
        const schemaFields = manifest.resultSchema[programIdKey];

        for (const fieldName in schemaFields) {
            const schemaValue = schemaFields[fieldName];
            const match = schemaValue.match(SCHEMA_REGEX);
            if (!match) {
                throw new Error(`[ERROR] Invalid resultSchema format for field '${fieldName}': "${schemaValue}". Expected "type(key)".`);
            }
            const type = match[1];
            const key = parseInt(match[2], 10);
            fieldMap.set(key, { name: fieldName, type });
        }
        parsedSchema.set(programIdHex, fieldMap);
    }

    return parsedSchema;
}


/**
 * Decodes a binary execution_result based on a schema in a manifest.
 * @param {Uint8Array} resultBuffer - The binary buffer of the execution result.
 * @param {object} manifest - The LTM manifest containing the resultSchema.
 * @returns {Promise<Map<string, object>>} - A map from program_id (hex) to the decoded result object.
 */
export async function decodeExecutionResult(resultBuffer, manifest) {
    const schema = await parseResultSchema(manifest);
    if (schema.size === 0 && resultBuffer.length > 0) {
        console.warn('[WARN] No resultSchema found in manifest. Returning raw decoded data.');
    }

    const decoder = new MsctpDecoder(resultBuffer);
    const results = new Map();

    while (decoder.hasNext()) {
        // 1. Decode Program ID
        const programId = decoder.readVector();
        const programIdHex = bytesToHex(programId);

        // 2. Decode Entry Count
        const entryCount = Number(decoder.readUleb128());

        const programSchema = schema.get(programIdHex);
        const decodedObject = {};

        // 3. Decode Key-Value Pairs
        for (let i = 0; i < entryCount; i++) {
            const key = Number(decoder.readUleb128());
            const typeId = decoder.peekType();
            
            let value;
            let fieldName = `key_${key}`; // Default name if no schema
            let type = 'unknown';

            if (programSchema && programSchema.has(key)) {
                const schemaEntry = programSchema.get(key);
                fieldName = schemaEntry.name;
                type = schemaEntry.type;
            }

            // Decode based on SCTP type ID, but validate against schema if present
            if (typeId === MSCTP_TT_ULEB128) {
                if (type !== 'uleb' && programSchema) {
                     console.warn(`[WARN] Type mismatch for ${fieldName}: schema says '${type}', but found 'uleb'.`);
                }
                value = decoder.readUleb128();
            } else if (typeId === MSCTP_TT_SLEB128) {
                if (type !== 'sleb' && programSchema) {
                    console.warn(`[WARN] Type mismatch for ${fieldName}: schema says '${type}', but found 'sleb'.`);
                }
                value = decoder.readSleb128();
            } else if (typeId === MSCTP_TT_SMALL_VECTOR || typeId === MSCTP_TT_LARGE_VECTOR) {
                 if (type !== 'vector' && programSchema) {
                     console.warn(`[WARN] Type mismatch for ${fieldName}: schema says '${type}', but found 'vector'.`);
                }
                value = decoder.readVector();
            } else {
                throw new Error(`[ERROR] Unsupported MSCTP type ID ${typeId} in result stream.`);
            }
            
            decodedObject[fieldName] = value;
        }
        
        results.set(programIdHex, decodedObject);
    }

    return results;
}


/**
 * Formats the decoded results into a user-friendly JSON string.
 * @param {Map<string, object>} decodedResults 
 * @returns {string}
 */
export function formatDecodedResult(decodedResults) {
    const output = {};
    for (const [programId, result] of decodedResults.entries()) {
        const formattedResult = {};
        for (const [key, value] of Object.entries(result)) {
            if (value instanceof BigInt) {
                formattedResult[key] = value.toString();
            } else if (value instanceof Uint8Array) {
                formattedResult[key] = bytesToHex(value);
            } else {
                formattedResult[key] = value;
            }
        }
        output[programId] = formattedResult;
    }
    return JSON.stringify(output, null, 2);
}