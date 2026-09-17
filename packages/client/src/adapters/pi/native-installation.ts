import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolImplementationInstallRecordV1 } from '@byok-sdk/implementation-identity';
import type { InputPreparationRuntimeIdentityV1 } from '../../input-preparation';
import { piRuntimeIdentityFromAttestedRecord } from './input-preparation';
import { resolvePiRuntimeIdentity } from './resolve-bin';

/** One native manifest comparison author, shared by measured observation and the bound child. */
export function verifyPiNativeInstallation(identity: ToolImplementationInstallRecordV1): InputPreparationRuntimeIdentityV1 {
  const manifestAsset = identity.assets?.find(asset => asset.path === 'package.json');
  if (identity.assetRoot === undefined || manifestAsset === undefined) throw new Error('Pi native package.json must be a declared asset');
  const bytes = readFileSync(path.join(identity.assetRoot, 'package.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== manifestAsset.digest) throw new Error('Pi native package.json byte digest mismatch');
  const manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const provenance = identity.nativeProvenance;
  if (provenance === undefined) throw new Error('Pi nativeProvenance is missing');
  const pin = resolvePiRuntimeIdentity();
  if (manifest.name !== provenance.packageName || manifest.name !== pin.name) throw new Error('Pi native packageName differs from record or static SDK pin');
  if (manifest.version !== provenance.packageVersion || manifest.version !== pin.version) throw new Error('Pi native packageVersion differs from record or static SDK pin');
  const fork = manifest.byokFork as Record<string, unknown> | undefined;
  for (const field of ['upstreamBase', 'upstreamCommit', 'forkBuild'] as const) {
    if (!fork || fork[field] !== provenance[field]) throw new Error(`Pi native byokFork.${field} differs from record`);
  }
  const runtimeIdentity = piRuntimeIdentityFromAttestedRecord(identity);
  return runtimeIdentity;
}
