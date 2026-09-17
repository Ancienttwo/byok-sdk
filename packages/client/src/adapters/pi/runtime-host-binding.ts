import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  assertImplementationSpawnBinding, parseImplementationSpawnBinding,
  type ImplementationSpawnBindingV1,
} from '@byok-sdk/implementation-identity';
import type { RuntimeLaunchKindV1 } from '../../daemon/tool-implementation-identity';
import { resolveInstalledPiRuntimeIdentity } from './input-preparation';
import { verifyPiNativeInstallation } from './native-installation';
import { verifyPiExportAssets } from './pi-export-assets';

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

export function requirePiHostBinding(value: unknown): ImplementationSpawnBindingV1 {
  const binding = parseImplementationSpawnBinding(value);
  if (binding === undefined) throw new Error('Pi host config.binding is not a valid implementation spawn binding');
  return binding;
}

/** Verify this process before constructing any native session or transport. */
export async function verifyPiHostBinding(
  binding: ImplementationSpawnBindingV1, kind: RuntimeLaunchKindV1,
  failDigest?: (message: string) => never,
) {
  const rawArgs = process.argv.slice(2);
  extractPiConfigDigest(rawArgs, failDigest); // Also reject a duplicate outside the handler's tail.
  const digestIndex = rawArgs.findIndex(arg => arg.startsWith(DIGEST_FLAG));
  const fixedArgv = rawArgs.slice(0, digestIndex);
  if (binding.identity.kind === 'attested'
    && binding.fixedArgv.at(-1) !== kind) {
    throw new Error('Pi host fixed dispatch prefix differs from runtime kind');
  }
  // Bun compiled argv[1] is /$bunfs/root/<entry>, not a separate physical
  // script. Its measured executable is process.execPath. Interpreted launches
  // carry their actual script in argv[1]. Both expose task argv at slice(2).
  const compiled = binding.identity.kind === 'attested' && binding.identity.form === 'compiled-executable';
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  await assertImplementationSpawnBinding(binding, {
    command: process.execPath, ...(compiled ? {} : { entry: process.argv[1] }),
    fixedArgv, cwd: process.cwd(), env,
  });
  const identity = binding.identity;
  if (identity.kind === 'unavailable') {
    // The shared strict parser permits only this explicitly unconfigured case.
    return resolveInstalledPiRuntimeIdentity();
  }
  const runtimeIdentity = verifyPiNativeInstallation(identity);
  verifyPiExportAssets(binding);
  return runtimeIdentity;
}
