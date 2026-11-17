const BASE64URL_VALUE = /^[A-Za-z0-9_-]*$/u;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Byte length of canonical unpadded base64url, including zero unused tail bits. */
export function canonicalBase64UrlByteLength(value: string): number | undefined {
  if (!BASE64URL_VALUE.test(value)) return undefined;
  const tail = value.length % 4;
  if (tail === 1) return undefined;
  if (tail !== 0) {
    const last = BASE64URL_ALPHABET.indexOf(value[value.length - 1]!);
    const unusedBits = tail === 2 ? 0b1111 : 0b11;
    if ((last & unusedBits) !== 0) return undefined;
  }
  return Math.floor(value.length / 4) * 3 + (tail === 0 ? 0 : tail - 1);
}
