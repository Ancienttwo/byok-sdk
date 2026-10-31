// Repository inputs consumed by conditional script tests, including inputs
// copied into temporary fixtures and source authorities for built outputs.
// These declarations add readers; they never admit an otherwise unmapped path.
export const scriptTestInputs = Object.freeze({
  'scripts/release/check-upgrade-manifest.test.mjs': { inputs: [
    /^api-surface\//,
    /^packages\/[^/]+\/package\.json$/,
    /^packages\/client\/(?:daemon-config\.schema|upgrade-manifest)\.json$/,
    /^packages\/server\/src\/stores\/sqlite\/index\.ts$/,
    /^packages\/client\/src\/(?:daemon\/journal\/sqlite-journal|util\/path-mutation-gate)\.ts$/,
    /^packages\/keys\/src\//,
    /^deploy\/sql\//,
    /^examples\/(?:host-execution-core|bot-collaboration)\/(?:package\.json$|src\/)/,
    /^scripts\/release\/(?:check-upgrade-manifest\.mjs$|upgrade-manifest\/)/,
  ] },
  'scripts/release/install-matrix.test.mjs': { inputs: [
    /^README\.md$/, /^packages\/[^/]+\/package\.json$/,
  ] },
  'scripts/release/pack-and-smoke.test.mjs': { inputs: [
    /^bun\.lock$/, /^LICENSE$/,
    /^(?:packages|examples)\/[^/]+\/package\.json$/,
    /^packages\/[^/]+\/(?:README\.md|LICENSE)$/,
    /^packages\/client\/tsup\.config\.ts$/,
    /^packages\/client\/src\/adapters\/pi\/official-pi-(?:installation\.mjs|closure\.json)$/,
    /^scripts\/release\/[^/]+\.mjs$/, /^scripts\/architecture\/dependency-graph\.mjs$/,
  ] },
  'scripts/release/beta-release.test.mjs': { inputs: [
    /^scripts\/release\/[^/]+\.mjs$/, /^scripts\/ci\/release-artifact\.mjs$/,
    /^packages\/client\/src\/adapters\/pi\/official-pi-(?:installation\.mjs|closure\.json)$/,
  ] },
  'scripts/release/agent-memory-helper-source.test.mjs': { inputs: [
    /^(?:package\.json|packages\/client\/package\.json)$/,
    /^scripts\/release\/(?:publish|pack-and-smoke)\.mjs$/,
    /^packages\/client\/scripts\/(?:check-agent-memory-helper-build|agent-memory-helper-source)\.mjs$/,
    /^packages\/client\/src\/util\/agent-memory-helper-release-pin\.ts$/,
    /^packages\/client\/native\/agent-memory-fs\//,
  ] },
  'scripts/release/registry-contract.test.mjs': { inputs: [/^scripts\/release\/registry-expectations\.json$/] },
  'scripts/release/publish.test.mjs': { inputs: [/^scripts\/release\/publish\.mjs$/] },
  'scripts/release/publish-recovery.test.mjs': { inputs: [/^scripts\/release\/publish\.mjs$/] },
  'scripts/docs/device-setup.test.mjs': { inputs: [
    /^docs\/device-setup\.md$/,
    /^packages\/client\/(?:daemon-config\.schema|upgrade-manifest)\.json$/,
    /^packages\/client\/src\/daemon\/(?:setup-error-catalog\.json|daemon-(?:errors|lifecycle)\.ts|config-schema\/(?:validate|errors|removed-fields)\.ts)$/,
    /^scripts\/docs\/device-setup\.mjs$/,
  ] },
  'scripts/api-surface/check-oar-bridge.test.mjs': { install: true, inputs: [
    /^packages\/(?:client|core|protocol)\/(?:src\/|package\.json$)/,
    /^bun\.lock$/,
    /^packages\/client\/vendor\/oar\//,
    /^scripts\/api-surface\/(?:oar-bridge-types\.ts|tsconfig\.oar-bridge\.json)$/,
    /^tsconfig\.json$/,
  ] },
  'scripts/api-surface/check-provisioning-code-alignment.test.mjs': { install: true, inputs: [
    /^packages\/(?:keys|protocol)\/(?:src\/|package\.json$|tsup\.config\.ts$)/,
  ] },
  'scripts/architecture/dependency-graph.test.mjs': { inputs: [
    /^scripts\/architecture\/dependency-(?:graph\.mjs|baseline\.json)$/,
    /^packages\/[^/]+\/(?:package\.json$|src\/(?!.*(?:\/__tests__\/|\.test\.|\.spec\.|\.d\.ts$)))/,
  ] },
});

/** One resolution supplies selector qualification, install planning and execution. */
export function resolveScriptChecks(paths, sourceRoutes, inputs = scriptTestInputs) {
  const tests = new Set(), families = new Set();
  let install = false;
  for (const path of paths) {
    const route = sourceRoutes[path];
    if (!route) continue;
    for (const test of route.tests) tests.add(test);
    for (const family of route.families ?? []) families.add(family);
    install ||= route.install === true;
  }
  for (const [test, declaration] of Object.entries(inputs)) {
    if (!paths.some(path => path === test || declaration.inputs.some(pattern => pattern.test(path)))) continue;
    tests.add(test);
  }
  // Requirements belong to the selected tests, including ones selected by a
  // source route rather than their artifact patterns.
  for (const test of tests) install ||= inputs[test]?.install === true || sourceRoutes[test]?.install === true;
  return { tests: [...tests].sort(), families: [...families].sort(), install };
}
