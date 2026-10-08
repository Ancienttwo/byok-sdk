import { createHash } from 'node:crypto';
import closure from './official-pi-closure.json' with { type: 'json' };

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const packages = new Map(closure.packages.map(entry => [entry.name, entry]));
for (const entry of packages.values()) {
  if (digest(JSON.stringify(entry.provenanceBundle)) !== entry.provenanceDigest) throw new Error(`official Pi provenance bundle digest mismatch: ${entry.name}`);
}
const coding = packages.get('@earendil-works/pi-coding-agent');
/**
 * The official Pi release the SDK pins, read from the provenance recorded when
 * the pin was set. The installed closure is not read: npm resolves the
 * indirect Pi packages to the newest compatible release.
 */
export const OFFICIAL_PI_PROVENANCE = Object.freeze({
  packageName: coding.name, packageVersion: coding.version,
  tarballIntegrity: coding.tarballIntegrity, upstreamCommit: coding.upstreamCommit,
  provenanceDigest: coding.provenanceDigest, closureDigest: digest(JSON.stringify(closure)), compilerVersion: 4,
});
