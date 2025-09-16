import * as msctp from './msctp.js';
import assert from 'assert';

function test(name, fn) {
    try {
        fn();
        console.log(`[PASS] ${name}`);
    } catch (error) {
        console.log(`[FAIL] ${name}`);
        throw error;
    }
}

function assertThrowsMsctpError(fn, expected_code, test_name) {
    assert.throws(fn, (err) => {
        assert(err instanceof msctp.MsctpError, `${test_name}: Error should be an instance of MsctpError`);
        assert.strictEqual(err.code, expected_code, `${test_name}: Error code mismatch`);
        return true;
    }, `${test_name}: Should throw`);
}


test('ULEB128 end-to-end', () => {
    const original_value = 150n;
    const encoder = new msctp.MsctpEncoder();
    encoder.addUleb128(original_value);
    const encoded = encoder.build();

    assert.ok(encoded, "ULEB128 encode success");
    assert.strictEqual(encoded.length, 3, "ULEB128 encode size"); // 1 header + 2 payload
    assert.deepStrictEqual(encoded, new Uint8Array([msctp.MSCTP_TT_ULEB128, 0x96, 0x01]), "ULEB128 encode content");

    const decoder = new msctp.MsctpDecoder(encoded);
    const decoded_value = decoder.readUleb128();
    assert.strictEqual(decoded_value, original_value, "ULEB128 e2e value match");
    assert.strictEqual(decoder.hasNext(), false, "Decoder is empty");
});

test('SLEB128 end-to-end', () => {
    const original_value = -101n;
    const encoder = new msctp.MsctpEncoder();
    encoder.addSleb128(original_value);
    const encoded = encoder.build();

    assert.ok(encoded, "SLEB128 encode success");
    assert.strictEqual(encoded.length, 3, "SLEB128 encode size"); // 1 header + 2 payload
    assert.deepStrictEqual(encoded, new Uint8Array([msctp.MSCTP_TT_SLEB128, 0x9b, 0x7f]), "SLEB128 encode content");

    const decoder = new msctp.MsctpDecoder(encoded);
    const decoded_value = decoder.readSleb128();
    assert.strictEqual(decoded_value, original_value, "SLEB128 e2e value match");
    assert.strictEqual(decoder.hasNext(), false, "Decoder is empty");
});

test('Vector: small payload (63 bytes)', () => {
    const payload_small = new Uint8Array(63).fill(0xAA);
    const encoder = new msctp.MsctpEncoder();
    encoder.addVector(payload_small);
    const encoded_small = encoder.build();

    assert.ok(encoded_small, "Vector (small) encode success");
    assert.strictEqual(encoded_small.length, 1 + 63, "Vector (small) encode size");
    assert.strictEqual(msctp.msctp_get_tt(encoded_small[0]), msctp.MSCTP_TT_SMALL_VECTOR, "Vector (small) type tag");

    const decoder = new msctp.MsctpDecoder(encoded_small);
    const payload = decoder.readVector();
    assert.deepStrictEqual(payload, payload_small, "Vector (small) payload match");
    assert.strictEqual(decoder.hasNext(), false, "Decoder is empty");
});

test('Vector: large payload (64 bytes)', () => {
    const payload_large = new Uint8Array(64).fill(0xCC);
    const encoder = new msctp.MsctpEncoder();
    encoder.addVector(payload_large);
    const encoded_large = encoder.build();

    assert.ok(encoded_large, "Vector (large) encode success");
    // 1 (vec header) + 1 (uleb payload for 64) + 64 (payload)
    assert.strictEqual(encoded_large.length, 1 + 1 + 64, "Vector (large) encode size");
    assert.strictEqual(msctp.msctp_get_tt(encoded_large[0]), msctp.MSCTP_TT_LARGE_VECTOR, "Vector (large) type tag");

    const decoder = new msctp.MsctpDecoder(encoded_large);
    const payload = decoder.readVector();
    assert.deepStrictEqual(payload, payload_large, "Vector (large) payload match");
    assert.strictEqual(decoder.hasNext(), false, "Decoder is empty");
});

console.log("\n--- Running Encoder/Decoder Tests ---");

test('Encoder/Decoder: simple sequence', () => {
    const encoder = new msctp.MsctpEncoder();
    encoder.addSleb128(-123n);
    encoder.addUleb128(456n);
    encoder.addVector(new Uint8Array([1, 2, 3]));
    const buffer = encoder.build();

    const decoder = new msctp.MsctpDecoder(buffer);

    assert.strictEqual(decoder.hasNext(), true, "Decoder should have data");
    assert.strictEqual(decoder.peekType(), msctp.MSCTP_TT_SLEB128, "Peek SLEB128");
    assert.strictEqual(decoder.readSleb128(), -123n, "Read SLEB128");

    assert.strictEqual(decoder.hasNext(), true, "Decoder should have data");
    assert.strictEqual(decoder.peekType(), msctp.MSCTP_TT_ULEB128, "Peek ULEB128");
    assert.strictEqual(decoder.readUleb128(), 456n, "Read ULEB128");

    assert.strictEqual(decoder.hasNext(), true, "Decoder should have data");
    assert.strictEqual(decoder.peekType(), msctp.MSCTP_TT_SMALL_VECTOR, "Peek Vector");
    assert.deepStrictEqual(decoder.readVector(), new Uint8Array([1, 2, 3]), "Read Vector");

    assert.strictEqual(decoder.hasNext(), false, "Decoder should be at the end");
});

console.log("\n[PASS] All tests completed.");
