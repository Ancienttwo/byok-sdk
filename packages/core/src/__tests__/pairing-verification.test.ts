/**
 * The pairing verification secret `pv` (#654 design §7.2, D2): generation,
 * the RFC 4648 base32 text form, and the `<pairing code>.<pv>` string. The
 * expected texts come from Python's `base64.b32encode` with the padding
 * removed.
 */
import { describe, expect, it } from 'vitest';

import { ByokCoreError } from '../errors';
import {
  PAIRING_VERIFICATION_SECRET_BYTES,
  PAIRING_VERIFICATION_TEXT_LENGTH,
  decodePairingVerificationSecret,
  encodePairingVerificationSecret,
  formatPairingInput,
  generatePairingVerificationSecret,
  parsePairingInput,
} from '../sealed-payload/pairing-verification';

const VECTORS: ReadonlyArray<{ bytes: Uint8Array; text: string }> = [
  { bytes: Uint8Array.from({ length: 16 }, (_, index) => index), text: 'AAAQEAYEAUDAOCAJBIFQYDIOB4' },
  { bytes: new Uint8Array(16).fill(0xff), text: '77777777777777777777777774' },
  { bytes: new TextEncoder().encode('byok-pv-vector!!'), text: 'MJ4W62ZNOB3C25TFMN2G64RBEE' },
  { bytes: new Uint8Array(16), text: 'A'.repeat(26) },
];

function expectInvalid(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ByokCoreError);
    expect((error as ByokCoreError).code).toBe('sealed_secret_invalid');
    return;
  }
  throw new Error('expected sealed_secret_invalid');
}

describe('pairing verification secret', () => {
  it('generates 128 fresh bits', () => {
    const first = generatePairingVerificationSecret();
    const second = generatePairingVerificationSecret();
    expect(first.byteLength).toBe(PAIRING_VERIFICATION_SECRET_BYTES);
    expect(PAIRING_VERIFICATION_SECRET_BYTES * 8).toBe(128);
    expect(Array.from(first)).not.toEqual(Array.from(second));
    expect(encodePairingVerificationSecret(first)).toHaveLength(PAIRING_VERIFICATION_TEXT_LENGTH);
  });

  it('encodes and decodes RFC 4648 base32 without padding', () => {
    for (const { bytes, text } of VECTORS) {
      expect(encodePairingVerificationSecret(bytes)).toBe(text);
      expect(Array.from(decodePairingVerificationSecret(text))).toEqual(Array.from(bytes));
    }
  });

  it('accepts lower case input and encodes upper case', () => {
    const { bytes, text } = VECTORS[0]!;
    expect(Array.from(decodePairingVerificationSecret(text.toLowerCase()))).toEqual(Array.from(bytes));
    const pv = generatePairingVerificationSecret();
    const encoded = encodePairingVerificationSecret(pv);
    expect(encoded).toBe(encoded.toUpperCase());
    expect(Array.from(decodePairingVerificationSecret(encoded))).toEqual(Array.from(pv));
  });

  it('rejects a wrong length, padding, characters outside the alphabet, and nonzero trailing bits', () => {
    const text = VECTORS[0]!.text;
    for (const bad of [
      '',
      text.slice(0, 25),
      `${text}A`,
      `${text}======`,
      `${text.slice(0, 25)}1`,
      `${text.slice(0, 25)}8`,
      ` ${text.slice(1)}`,
      // The last character carries 3 data bits and 2 bits that must be zero.
      `${text.slice(0, 25)}B`,
      `${text.slice(0, 25)}5`,
      // Unicode case mapping must not turn these into ASCII letters.
      `\u017f${text.slice(1)}`,
      `\ufb00${text.slice(2)}`,
    ]) {
      expectInvalid(() => decodePairingVerificationSecret(bad));
    }
    for (const length of [0, 15, 17, 32]) {
      expectInvalid(() => encodePairingVerificationSecret(new Uint8Array(length)));
    }
  });

  it('formats and parses <pairing code>.<pv>, splitting on the last dot', () => {
    const pv = generatePairingVerificationSecret();
    for (const code of ['ABCD2345', 'product.code.with.dots', 'x']) {
      const input = formatPairingInput(code, pv);
      expect(input).toBe(`${code}.${encodePairingVerificationSecret(pv)}`);
      const parsed = parsePairingInput(input);
      expect(parsed.pairingCode).toBe(code);
      expect(Array.from(parsed.pv)).toEqual(Array.from(pv));
    }
  });

  it('requires both parts and never treats a bare pairing code as complete', () => {
    const text = VECTORS[0]!.text;
    for (const bad of [
      'ABCD2345',
      `.${text}`,
      `ABCD2345.`,
      `ABCD2345.${text.slice(0, 25)}`,
      `ABCD2345.${text}.`,
      `${text}`,
    ]) {
      expectInvalid(() => parsePairingInput(bad));
    }
    expectInvalid(() => formatPairingInput('', generatePairingVerificationSecret()));
  });
});
