/** Shared by source-graph, packed-artifact, and registry-readback gates. */
export function assertImplementationIdentityDependency(manifest, expectedVersion) {
  const dependency = '@byok-sdk/implementation-identity';
  const actual = manifest?.dependencies?.[dependency];
  if (actual !== expectedVersion) {
    throw new Error(`${manifest?.name}: dependency ${dependency} is ${actual ?? '(missing)'}, expected ${expectedVersion}`);
  }
  for (const field of ['optionalDependencies', 'peerDependencies']) {
    if (Object.hasOwn(manifest[field] ?? {}, dependency)) {
      throw new Error(`${manifest.name}: ${dependency} must be a required dependency, not ${field}`);
    }
  }
}
