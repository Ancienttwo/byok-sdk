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
 * The two pairing MACs (§7.2 steps 3 and 4) key HMAC-SHA-256 with `pv`. The
 * design writes their inputs with `||`. Here each input is a domain tag and
 * the canonical JSON of named fields, so field boundaries are unambiguous and
 * a device MAC never verifies as a client MAC.
 *
 * This module is internal: the subpath index does not export it.
 */
import { z } from 'zod';

import { canonicalizeJsonBytes } from '../attestation';
import { CONTENT_HASH_PATTERN } from '../blob';
import { webCryptoSubtle, type WebCryptoKey } from '../webcrypto';
import type { MemberKeyBundleV1 } from './member-bundle';
import {
  base64UrlBytes,
  concat,
  copy,
  decodeBase64Url,
  encodeBase64Url,
  hmacSha256,
  invalidInput,
  randomBytes,
  utf8,
  type Bytes,
} from './primitives';

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

/** Domain tag of the MAC the device sends: step 3, `HMAC(pv, device bundle, tenantId, deviceId)`. */
export const DEVICE_PAIRING_MAC_DOMAIN = 'byok-pairing-device-mac-v1\n';
/** Domain tag of the MAC the client sends: step 4, `HMAC(pv, client bundle, chain head)`. */
export const CLIENT_PAIRING_MAC_DOMAIN = 'byok-pairing-client-mac-v1\n';

/** A pairing MAC on the wire: base64url of the 32-byte HMAC-SHA-256 tag. */
const PairingMacSchema = base64UrlBytes(32);

export interface DevicePairingMacInput {
  readonly tenantId: string;
  readonly deviceId: string;
  /** The device's own bundle. Its `deviceId` must equal `deviceId`. */
  readonly member: MemberKeyBundleV1;
}

export interface ClientPairingMacInput {
  /** The client's own bundle. A client bundle has no `deviceId`. */
  readonly member: MemberKeyBundleV1;
  /** The chain head after the client signed `add(device)`. */
  readonly chainHead: { readonly seq: number; readonly hash: string };
}

const ChainHeadSchema = z.strictObject({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hash: z.string().regex(CONTENT_HASH_PATTERN),
});

function devicePairingMacInput(input: DevicePairingMacInput): Bytes {
  if (input.tenantId.length === 0 || input.deviceId.length === 0 || input.member.deviceId !== input.deviceId) {
    throw invalidInput('Device pairing MAC input must name the device member\'s own device id');
  }
  return concat(
    utf8(DEVICE_PAIRING_MAC_DOMAIN),
    canonicalizeJsonBytes({ tenantId: input.tenantId, deviceId: input.deviceId, member: bundleJson(input.member) }),
  );
}

function clientPairingMacInput(input: ClientPairingMacInput): Bytes {
  const head = ChainHeadSchema.safeParse(input.chainHead);
  if (input.member.deviceId !== undefined || !head.success) {
    throw invalidInput('Client pairing MAC input must hold a client member and a chain head');
  }
  return concat(
    utf8(CLIENT_PAIRING_MAC_DOMAIN),
    canonicalizeJsonBytes({ member: bundleJson(input.member), chainHead: { seq: head.data.seq, hash: head.data.hash } }),
  );
}

function bundleJson(member: MemberKeyBundleV1) {
  const jwk = (key: MemberKeyBundleV1['signingPublicJwk']) => ({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
  return {
    v: member.v,
    memberId: member.memberId,
    signingPublicJwk: jwk(member.signingPublicJwk),
    kemPublicJwk: jwk(member.kemPublicJwk),
    kemEpoch: member.kemEpoch,
    ...(member.deviceId === undefined ? {} : { deviceId: member.deviceId }),
  };
}

function checkPv(pv: Uint8Array): void {
  if (pv.byteLength !== PAIRING_VERIFICATION_SECRET_BYTES) {
    throw invalidInput(`Pairing verification secret must be ${PAIRING_VERIFICATION_SECRET_BYTES} bytes`);
  }
}

export async function computeDevicePairingMac(pv: Uint8Array, input: DevicePairingMacInput): Promise<string> {
  checkPv(pv);
  return encodeBase64Url(await hmacSha256(pv, devicePairingMacInput(input)));
}

export async function computeClientPairingMac(pv: Uint8Array, input: ClientPairingMacInput): Promise<string> {
  checkPv(pv);
  return encodeBase64Url(await hmacSha256(pv, clientPairingMacInput(input)));
}

/**
 * Check a received device MAC. Parse the received bundle with
 * `parseMemberKeyBundle` first. Returns `false` for a wrong or malformed MAC,
 * or a bundle that does not name `deviceId`. Only a malformed `pv` throws.
 */
export async function verifyDevicePairingMac(pv: Uint8Array, input: DevicePairingMacInput, mac: unknown): Promise<boolean> {
  checkPv(pv);
  return hmacVerify(pv, () => devicePairingMacInput(input), mac);
}

/**
 * Check a received client MAC. Parse the received bundle with
 * `parseMemberKeyBundle` first. Returns `false` for a wrong or malformed MAC,
 * a device bundle, or a malformed chain head. Only a malformed `pv` throws.
 */
export async function verifyClientPairingMac(pv: Uint8Array, input: ClientPairingMacInput, mac: unknown): Promise<boolean> {
  checkPv(pv);
  return hmacVerify(pv, () => clientPairingMacInput(input), mac);
}

/**
 * WebCrypto HMAC verify compares in constant time. Core's public
 * `WebCryptoSubtle` interface does not declare `verify`, so this module types
 * the same runtime object locally, as `primitives.ts` does for ECDSA.
 */
interface HmacVerifySubtle {
  importKey(format: 'raw', keyData: Bytes, algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
  verify(algorithm: string, key: WebCryptoKey, signature: Bytes, data: Bytes): Promise<boolean>;
}

async function hmacVerify(key: Uint8Array, buildData: () => Bytes, mac: unknown): Promise<boolean> {
  const parsed = PairingMacSchema.safeParse(mac);
  if (!parsed.success) return false;
  let data: Bytes;
  try {
    data = buildData();
  } catch {
    return false;
  }
  const subtle = webCryptoSubtle() as unknown as HmacVerifySubtle;
  const hmacKey = await subtle.importKey('raw', copy(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return subtle.verify('HMAC', hmacKey, decodeBase64Url(parsed.data, 'mac'), data);
}
