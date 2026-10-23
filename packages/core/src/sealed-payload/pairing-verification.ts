/**
 * The pairing verification secret `pv` (#654 design §7.2, D2).
 *
 * The client generates `pv` when it shows a pairing code, and shows
 * `<pairing code>.<pv>`. The user gives that string to the device. The device
 * sends only the pairing code to the Host and keeps `pv`. The Host never sees
 * `pv`, so it cannot replace a member public key during pairing.
 *
 * Text form: RFC 4648 base32 of the 16 bytes, without padding. That is 26
 * characters. The encoder writes upper case. The decoder also accepts lower
 * case, because a person may type the string. The two unused low bits of the
 * last character must be zero, so one value has one upper-case text form.
 *
 * The parser splits on the LAST `.`, because base32 has no `.` and a pairing
 * code may contain one. It requires `pv`: the daemon decides from its own
 * configuration that a pairing needs `pv`, and never infers it from the text.
 *
 * The pairing MACs over member key bundles belong to the slice that adds the
 * member registration operation. This module is internal: the subpath index
 * does not export it.
 */
import { invalidInput, randomBytes, type Bytes } from './primitives';

export const PAIRING_VERIFICATION_SECRET_BYTES = 16;
export const PAIRING_VERIFICATION_TEXT_LENGTH = 26;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Checked on the raw text, before upper-casing: Unicode case mapping turns
// some non-ASCII characters into ASCII letters (`ſ` to `S`, `ﬀ` to `FF`).
const PV_TEXT_PATTERN = /^[A-Za-z2-7]{26}$/u;

/** 128 fresh CSPRNG bits. */
export function generatePairingVerificationSecret(): Bytes {
  return randomBytes(PAIRING_VERIFICATION_SECRET_BYTES);
}

export function encodePairingVerificationSecret(pv: Uint8Array): string {
  if (pv.byteLength !== PAIRING_VERIFICATION_SECRET_BYTES) {
    throw invalidInput(`Pairing verification secret must be ${PAIRING_VERIFICATION_SECRET_BYTES} bytes`);
  }
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of pv) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return out + BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
}

export function decodePairingVerificationSecret(text: string): Bytes {
  if (!PV_TEXT_PATTERN.test(text)) {
    throw invalidInput(`Pairing verification secret must be ${PAIRING_VERIFICATION_TEXT_LENGTH} base32 characters`);
  }
  const upper = text.toUpperCase();
  const out = new Uint8Array(PAIRING_VERIFICATION_SECRET_BYTES);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of upper) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >>> bits) & 0xff;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) throw invalidInput('Pairing verification secret has nonzero trailing bits');
  return out as Bytes;
}

/** `<pairingCode>.<pv>`, the string the client shows and the user gives to the device. */
export function formatPairingInput(pairingCode: string, pv: Uint8Array): string {
  if (pairingCode.length === 0) throw invalidInput('Pairing code must not be empty');
  return `${pairingCode}.${encodePairingVerificationSecret(pv)}`;
}

export interface PairingInput {
  /** The only part the device sends to the Host. */
  readonly pairingCode: string;
  /** Kept on the device; never sent to the Host. */
  readonly pv: Bytes;
}

/** Split `<pairingCode>.<pv>` on the last `.`. Both parts are required. */
export function parsePairingInput(text: string): PairingInput {
  const dot = text.lastIndexOf('.');
  if (dot <= 0) throw invalidInput('Pairing input must be <pairing code>.<verification secret>');
  return { pairingCode: text.slice(0, dot), pv: decodePairingVerificationSecret(text.slice(dot + 1)) };
}
