import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DIGEST_FLAG = '--config-digest=';
const SHA256 = /^[0-9a-f]{64}$/u;

/** Serialize once; the writer must write these exact bytes without re-encoding. */
export function serializePiHostConfig(value: unknown): { bytes: Buffer; digest: string } {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

/** This flag belongs to the launcher, not to Pi's delegated option namespace. */
export function extractPiConfigDigest(
  argv: readonly string[],
  fail: (message: string) => never = (message) => { throw new Error(message); },
): { digest: string; args: string[] } {
  const candidates = argv.filter(arg => arg === '--config-digest' || arg.startsWith(DIGEST_FLAG));
  if (candidates.length !== 1) fail('exactly one --config-digest=<sha256> is required');
  const flag = candidates[0]!;
  const digest = flag.slice(DIGEST_FLAG.length);
  if (!flag.startsWith(DIGEST_FLAG) || !SHA256.test(digest)) fail('--config-digest must contain 64 lowercase hexadecimal characters');
  return { digest, args: argv.filter(arg => arg !== flag) };
}

/** Checksum and parse consume the same single read, including non-binding fields. */
export function readPiHostConfig(configPath: string, digest: string): unknown {
  const bytes = readFileSync(configPath);
  if (!SHA256.test(digest) || createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error('Pi host config byte digest mismatch');
  }
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
