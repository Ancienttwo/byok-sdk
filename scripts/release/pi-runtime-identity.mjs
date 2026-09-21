// Single authority for the Pi runtime identity across the release gates.
//
// `packages/client/package.json` pins one specifier,
// `@earendil-works/pi-coding-agent`, to an exact npm alias
// (`npm:@byok-sdk/pi-coding-agent@<x.y.z>`) because the SDK ships a fork of the
// upstream runtime. That keeps the specifier and the installed directory path
// unchanged while the manifest inside carries the fork's own name and version.
// Every release gate derives both halves here instead of hardcoding either.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** The module specifier and node_modules path the SDK resolves Pi through. */
export const PI_DEPENDENCY_SPECIFIER = '@earendil-works/pi-coding-agent';

/**
 * Upstream commit the published fork is built from. Recorded in the fork's
 * `byokFork` manifest block; an installed runtime that does not carry exactly
 * this base is not the artifact this repo's gates were written against.
 */
export const PI_FORK_UPSTREAM_COMMIT = '13cbf77df2396303013a41646bcfa77b4271ae56';

/**
 * Entry the fork must ship for the prepared-session-input seam this pin exists
 * to deliver, relative to the installed Pi package root.
 */
export const PI_PREPARED_INPUT_ENTRY = path.join('dist', 'core', 'prepared-session-input.js');

const PI_ALIAS_SPEC =
  /^npm:(@[^/@\s]+\/[^/@\s]+|[^@/\s][^/@\s]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

/**
 * Parse the exact Pi runtime identity out of a `@byok-sdk/client` manifest.
 * Ranges, dist-tags and bare versions are rejected: a release gate cannot
 * verify an installed runtime whose expected identity is not exact.
 *
 * @param {{ dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }} clientManifest
 * @param {string} [label] manifest origin, used in error messages
 * @returns {{ specifier: string, spec: string, packageName: string, version: string }}
 */
export function parsePiRuntimeIdentity(clientManifest, label = 'packages/client/package.json') {
  const spec = clientManifest?.dependencies?.[PI_DEPENDENCY_SPECIFIER];
  if (typeof spec !== 'string') {
    throw new Error(`${label}: ${PI_DEPENDENCY_SPECIFIER} must be a required dependency`);
  }
  const match = PI_ALIAS_SPEC.exec(spec);
  if (match === null) {
    throw new Error(
      `${label}: ${PI_DEPENDENCY_SPECIFIER} must be pinned to an exact npm:<name>@x.y.z fork alias, got ${spec}`,
    );
  }
  return { specifier: PI_DEPENDENCY_SPECIFIER, spec, packageName: match[1], version: match[2] };
}

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Collect every installed package manifest under `installRoot/node_modules`,
 * including nested `node_modules` trees, as `{ root, manifest }` pairs. Package
 * roots only: `node_modules/<name>` and `node_modules/@scope/<name>`.
 *
 * @param {string} installRoot
 */
function collectInstalledPackages(installRoot) {
  const found = [];
  const seen = new Set();
  const queue = [path.join(installRoot, 'node_modules')];
  while (queue.length > 0) {
    const modulesDir = queue.pop();
    if (!existsSync(modulesDir)) continue;
    // Symlinked stores (pnpm/bun layouts) can point back up the tree; walk each
    // real directory exactly once.
    const realModulesDir = realpathSync(modulesDir);
    if (seen.has(realModulesDir)) continue;
    seen.add(realModulesDir);
    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === '.bin') continue;
      const roots = entry.name.startsWith('@')
        ? readdirSync(path.join(modulesDir, entry.name), { withFileTypes: true })
            .filter((scoped) => scoped.isDirectory() || scoped.isSymbolicLink())
            .map((scoped) => path.join(modulesDir, entry.name, scoped.name))
        : [path.join(modulesDir, entry.name)];
      for (const root of roots) {
        const manifest = readManifest(path.join(root, 'package.json'));
        if (manifest !== undefined) found.push({ root, manifest });
        queue.push(path.join(root, 'node_modules'));
      }
    }
  }
  return found;
}

/**
 * Prove an isolated install resolved to exactly one coding-agent runtime, that
 * it is the pinned fork build, and that it exposes the prepared-input surface
 * this pin exists for. Throws on the first violation.
 *
 * @param {string} installRoot directory whose `node_modules` was installed
 * @param {{ packageName: string, version: string }} identity from `parsePiRuntimeIdentity`
 * @param {string} label gate name, used in error messages
 * @returns {{ root: string, manifest: Record<string, unknown> }} the single installed Pi package
 */
export function assertInstalledPiRuntime(installRoot, identity, label) {
  const installed = collectInstalledPackages(installRoot);
  const forks = installed.filter((entry) => entry.manifest.name === identity.packageName);
  const upstream = installed.filter((entry) => entry.manifest.name === PI_DEPENDENCY_SPECIFIER);
  if (forks.length !== 1) {
    throw new Error(
      `${label}: expected exactly one installed ${identity.packageName}, found ${forks.length}` +
        `${forks.length === 0 ? '' : ` at ${forks.map((entry) => path.relative(installRoot, entry.root)).join(', ')}`}`,
    );
  }
  if (upstream.length !== 0) {
    throw new Error(
      `${label}: upstream ${PI_DEPENDENCY_SPECIFIER} must not be installed alongside the fork, found ${upstream.length} at ` +
        `${upstream.map((entry) => path.relative(installRoot, entry.root)).join(', ')}`,
    );
  }
  const [pi] = forks;
  if (pi.manifest.version !== identity.version) {
    throw new Error(
      `${label}: installed ${identity.packageName}@${pi.manifest.version}, expected ${identity.version}`,
    );
  }
  const preparedInput = path.join(pi.root, PI_PREPARED_INPUT_ENTRY);
  if (!existsSync(preparedInput)) {
    throw new Error(`${label}: installed Pi runtime is missing ${PI_PREPARED_INPUT_ENTRY}`);
  }
  if (pi.manifest.byokFork?.upstreamCommit !== PI_FORK_UPSTREAM_COMMIT) {
    throw new Error(
      `${label}: installed Pi runtime declares byokFork.upstreamCommit ` +
        `${JSON.stringify(pi.manifest.byokFork?.upstreamCommit)}, expected ${PI_FORK_UPSTREAM_COMMIT}`,
    );
  }
  console.log(
    `[${label}] single ${identity.packageName}@${identity.version} runtime at ` +
      `${path.relative(installRoot, pi.root)}; upstream ${PI_DEPENDENCY_SPECIFIER} manifests=0; ` +
      `${PI_PREPARED_INPUT_ENTRY} present; byokFork.upstreamCommit=${PI_FORK_UPSTREAM_COMMIT}`,
  );
  return pi;
}
