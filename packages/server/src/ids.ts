import { randomBytes, randomUUID } from 'node:crypto';

/** Short, human-typeable pairing code (uppercase alnum, unambiguous alphabet). */
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePairingCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i]! % PAIRING_CODE_ALPHABET.length];
  }
  return out;
}

export function generateDeviceId(): string {
  return `dev_${randomUUID()}`;
}

export function generateTaskId(): string {
  return `task_${randomUUID()}`;
}
