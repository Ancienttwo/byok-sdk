import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertImplementationIdentityDependency } from './implementation-identity-edges.mjs';
import { parseBunLock, parsePiRuntimeIdentity, PI_DEPENDENCY_SPECIFIER, readLockedPiClosure } from './pi-runtime-identity.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dispatchPackages = [
  ['packages/core', '@byok-sdk/core'],
  ['packages/protocol', '@byok-sdk/protocol'],
  ['packages/client', '@byok-sdk/client'],
  ['packages/server', '@byok-sdk/server'],
  ['packages/cloud', '@byok-sdk/cloud'],
  ['packages/cloud-dataplane', '@byok-sdk/cloud-dataplane'],
  ['packages/ui-runtime', '@byok-sdk/ui-runtime'],
];
const keys = ['packages/keys', '@byok-sdk/keys'];
const implementationIdentity = ['packages/implementation-identity', '@byok-sdk/implementation-identity'];
const alignedPackages = [...dispatchPackages, implementationIdentity];
// The published set is exactly these packages: the aligned train plus the
// independently versioned keys. Every other workspace manifest under
// packages/ must be private, because publish.mjs publishes every non-private
// manifest it finds there. Since 0.21.0 the `byok-sdk` umbrella is retired
// (ADR-035: no empty umbrella, alias package or dual export) and
// `@byok-sdk/testkit` is private, consumed only by the private conformance
// suite; the check below rejects either one coming back as a public package.
const publicPackages = [...alignedPackages, keys];
const privatePackages = [
  ['packages/conformance', '@byok-sdk/conformance'],
  ['packages/testkit', '@byok-sdk/testkit'],
];
const retiredPublicNames = ['byok-sdk'];
const errors = [];

// @byok-sdk/client must install as pure JavaScript: a direct dependency that ships a prebuilt
// `.node` addon or runs an install script turns an end user's install into a compile/download step
// and breaks the SEA/bun single-file packagability invariant. Direct dependencies only — the
// transitive closure is deliberately out of scope, since scoping it would require an allowlist.
//
// `optionalDependencies` is the one narrow exception, and it is narrow on purpose. It may carry a
// native addon ONLY when a single platform genuinely requires it, that platform fails CLOSED on its
// absence (no degraded path, no silent skip), and no other platform ever loads the module. `koffi`
// is the only such entry today: the win32 kill-on-close Job Object that owns runtime process trees
// (packages/client/src/adapters/win32-job-object.ts) has no pure-JS equivalent, a Windows daemon
// refuses to start a runtime without it, and POSIX reaches the module through a win32-only dynamic
// import that never runs. npm has no per-platform install field other than this one, so the manifest
// field is a distribution mechanism; the runtime rule is what carries the hardness.
//
// The checks below keep that exception from widening. Every optional dependency stays exactly
// pinned, none may also be a hard dependency or be inlined into the bundle by tsup (`noExternal`)
// -- either of which would make a POSIX install load it after all -- and every optional dependency
// is run through the SAME purity audit as the direct ones (install scripts plus shipped `.node`
// addons). A purity violation is an error unless the package is named in
// `OPTIONAL_NATIVE_ALLOWLIST` below, and an allowlist entry that is not actually present in
// `optionalDependencies` is an error too, so a carve-out cannot outlive the dependency it was
// written for. koffi is the only entry today, and it does violate the audit: koffi 3.2.0 declares
// an `install` script (`node ./cnoke.cjs -P . -D src/koffi --prebuild --release`) and ships no
// `.node` file of its own, resolving its addon from the os/cpu-scoped `@koromix/koffi-<os>-<arch>`
// siblings instead. That is acceptable precisely because of those prebuilt siblings: the install
// script is a prebuild check that finds the addon already present and does nothing, bun never runs
// it, and POSIX never loads the module. A second native optional entry gets none of this silently
// -- it fails the gate until someone writes it into the allowlist with its own justification.
const OPTIONAL_NATIVE_ALLOWLIST = {
  koffi: 'win32 kill-on-close job object; per-platform prebuilt from @koromix/koffi-* makes the install script a no-op, bun never runs it, and POSIX never loads the module',
};
const installScriptFields = ['preinstall', 'install', 'postinstall'];

/** Walks the node_modules chain upward, mirroring Node's own resolution; Bun's workspace links resolve to their real package location. */
function resolvePackageDir(fromDirectory, name) {
  let current = fromDirectory;
  for (;;) {
    const candidate = path.join(current, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Returns the first shipped `.node` addon path relative to the package directory, or undefined. Nested node_modules are another package's problem. */
function findNativeAddon(packageDirectory) {
  const stack = [packageDirectory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.node')) return path.relative(packageDirectory, entryPath);
    }
  }
  return undefined;
}

/** Returns the purity violations of one installed package directory, prefixed with the caller's label. */
function auditPackagePurity(label, packageDirectory) {
  const violations = [];
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
  for (const field of installScriptFields) {
    if (manifest.scripts?.[field]) violations.push(`${label} declares a ${field} script`);
  }
  const addon = findNativeAddon(packageDirectory);
  if (addon) violations.push(`${label} ships a native addon (${addon})`);
  return violations;
}

// Negative control for the rule above: audit one installed package directory and nothing else, so
// the scan can be proven red against a known violating input instead of only green on today's graph.
const selfTestIndex = process.argv.indexOf('--self-test');
if (selfTestIndex !== -1) {
  const target = process.argv[selfTestIndex + 1];
  if (!target) {
    console.error('[release-graph] --self-test requires an installed package directory');
    process.exit(2);
  }
  const targetDirectory = path.resolve(target);
  const violations = auditPackagePurity(`self-test ${targetDirectory}`, targetDirectory);
  for (const violation of violations) console.error(`[release-graph] ${violation}`);
  if (violations.length > 0) process.exit(1);
  console.log(`[release-graph] self-test OK: ${targetDirectory} is pure JavaScript`);
  process.exit(0);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

// Version authority: the manifests themselves, never a constant in this file.
// The release train version is whatever packages/core ships, keys versions
// independently from packages/keys, and the pi pin from packages/client.
// Every check below compares against these derived values, so a train bump
// cannot desync the gate from the manifests it guards.
// Release packages may use an exact SemVer prerelease (for example
// 0.8.0-beta.0). The Pi runtime remains a stable, exact pin because it is not
// part of the SDK release channel; it is declared as an exact official version
// and read through the one shared `parsePiRuntimeIdentity` authority.
const exactStableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const exactReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const releaseVersion = readJson('packages/core/package.json').version;
const keysVersion = readJson('packages/keys/package.json').version;
let piRuntime;
try {
  piRuntime = parsePiRuntimeIdentity(readJson('packages/client/package.json'));
} catch (error) {
  errors.push(error.message);
}
if (typeof releaseVersion !== 'string' || !exactReleaseVersion.test(releaseVersion)) {
  errors.push('packages/core/package.json: version must be an exact SemVer release train version');
}
if (typeof keysVersion !== 'string' || !exactReleaseVersion.test(keysVersion)) {
  errors.push('packages/keys/package.json: version must be an exact SemVer version');
}
if (keysVersion === releaseVersion) {
  errors.push(`packages/keys/package.json: keys must remain independently versioned from the ${releaseVersion} dispatch train`);
}

const manifests = new Map();
for (const [directory, expectedName] of publicPackages) {
  const manifestPath = `${directory}/package.json`;
  const manifest = readJson(manifestPath);
  manifests.set(manifest.name, manifest);
  if (manifest.name !== expectedName) errors.push(`${manifestPath}: expected name ${expectedName}, got ${manifest.name}`);
  const expectedVersion = expectedName === keys[1] ? keysVersion : releaseVersion;
  if (manifest.version !== expectedVersion) errors.push(`${manifestPath}: expected version ${expectedVersion}, got ${manifest.version}`);
  if (manifest.license !== 'MIT') errors.push(`${manifestPath}: license must be MIT`);
  if (manifest.publishConfig?.access !== 'public') errors.push(`${manifestPath}: publishConfig.access must be public`);
  const expectedEngine = '>=22.22.0';
  if (manifest.engines?.node !== expectedEngine) errors.push(`${manifestPath}: engines.node must be ${expectedEngine}`);
  if (manifest.repository?.url !== 'git+https://github.com/Ancienttwo/byok-sdk.git') {
    errors.push(`${manifestPath}: repository URL is not canonical`);
  }
  if (manifest.repository?.directory !== directory) errors.push(`${manifestPath}: repository.directory must be ${directory}`);
  for (const shipped of ['dist', 'README.md', 'LICENSE']) {
    if (!manifest.files?.includes(shipped)) errors.push(`${manifestPath}: files must include ${shipped}`);
  }
  if (manifest.exports?.['.']?.import !== './dist/index.js' || manifest.exports?.['.']?.types !== './dist/index.d.ts') {
    errors.push(`${manifestPath}: root import/types exports are incomplete`);
  }
  for (const shipped of ['README.md', 'LICENSE']) {
    if (!existsSync(path.join(repoRoot, directory, shipped))) errors.push(`${directory}/${shipped}: missing`);
  }
  if (readFileSync(path.join(repoRoot, directory, 'LICENSE'), 'utf8') !== readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8')) {
    errors.push(`${directory}/LICENSE: must match the root license byte-for-byte`);
  }
}

// --- bun.lock drift guard -------------------------------------------------
// `bun pm pack` resolves `workspace:*` edges from bun.lock's workspace
// records, not from the manifests, and `bun install` does NOT rewrite those
// records on version-only bumps. A stale record publishes tarballs whose
// internal @byok-sdk edges point at the previous train — the split registry
// graph v0.4.1 shipped with. The lockfile is therefore compared directly
// against every workspace manifest, and a mismatch is a hand-edit error:
// re-running bun install will not fix it.

const lockfileText = readFileSync(path.join(repoRoot, 'bun.lock'), 'utf8');
let workspaceRecords;
try {
  workspaceRecords = parseBunLock(lockfileText).workspaces ?? {};
} catch (error) {
  errors.push(`bun.lock: unparseable (${error.message})`);
  workspaceRecords = {};
}
for (const [directory, record] of Object.entries(workspaceRecords)) {
  if (directory === '') continue; // the workspace root record carries no version
  const manifestPath = `${directory}/package.json`;
  if (!existsSync(path.join(repoRoot, manifestPath))) {
    errors.push(`bun.lock: workspace record ${directory} has no ${manifestPath}`);
    continue;
  }
  const manifestVersion = readJson(manifestPath).version;
  if (record.version !== manifestVersion) {
    errors.push(
      `bun.lock: workspace record for ${directory} says version ${record.version}, but ${manifestPath} says ${manifestVersion} — ` +
        'correct the bun.lock record by hand; bun install will not fix it on version-only bumps',
    );
  }
}
// The official Pi closure is exact and integrity-locked, with no fork alias.
if (piRuntime !== undefined) {
  try {
    readLockedPiClosure(lockfileText, piRuntime);
  } catch (error) {
    errors.push(error.message);
  }
}
for (const directory of publicPackages.map(([directory]) => directory)) {
  if (!workspaceRecords[directory]) {
    errors.push(`bun.lock: missing workspace record for ${directory} — bun pm pack cannot resolve its workspace edges without it`);
  }
}

// --- Published-set closure ------------------------------------------------
// publish.mjs derives its publish set from every non-private manifest under
// packages/, so the declared publicPackages list only binds publication if
// every other manifest there is private. A new public manifest, a retired
// name reappearing, or a private package drifting public fails here.
const declaredPublicDirectories = new Set(publicPackages.map(([directory]) => directory));
const declaredPrivate = new Map(privatePackages);
for (const entry of readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = `packages/${entry.name}`;
  const manifestPath = `${directory}/package.json`;
  if (!existsSync(path.join(repoRoot, manifestPath))) continue;
  const manifest = readJson(manifestPath);
  if (retiredPublicNames.includes(manifest.name)) {
    errors.push(`${manifestPath}: ${manifest.name} is retired and must not exist as a workspace package`);
  }
  if (declaredPublicDirectories.has(directory)) {
    if (manifest.private === true) errors.push(`${manifestPath}: a published package must not be private`);
    continue;
  }
  const expectedPrivateName = declaredPrivate.get(directory);
  if (expectedPrivateName === undefined) {
    errors.push(`${manifestPath}: undeclared workspace package; add it to the published set or to privatePackages in scripts/release/check-package-graph.mjs`);
    continue;
  }
  if (manifest.name !== expectedPrivateName || manifest.private !== true) {
    errors.push(`${manifestPath}: must remain private ${expectedPrivateName}`);
  }
  if (manifest.version !== '0.0.0') {
    errors.push(`${manifestPath}: a private package carries version 0.0.0, not a release train version`);
  }
  if (manifest.publishConfig !== undefined) {
    errors.push(`${manifestPath}: a private package must not declare publishConfig`);
  }
  if (manifest.engines?.node !== '>=22.22.0') {
    errors.push(`${manifestPath}: engines.node must be >=22.22.0`);
  }
}
for (const [directory] of privatePackages) {
  if (!existsSync(path.join(repoRoot, directory, 'package.json'))) errors.push(`${directory}/package.json: missing`);
}

const runtimeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
function runtimeEdges(manifest) {
  return runtimeFields.flatMap((field) => Object.keys(manifest[field] ?? {}));
}

for (const [, packageName] of alignedPackages) {
  const seen = new Set();
  const queue = [packageName];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === keys[1]) errors.push(`${packageName}: runtime dependency graph reaches ${keys[1]}`);
    const manifest = manifests.get(current);
    if (!manifest) continue;
    for (const dependency of runtimeEdges(manifest)) {
      if (manifests.has(dependency)) queue.push(dependency);
    }
  }
}

const keysManifest = manifests.get(keys[1]);
for (const field of [...runtimeFields, 'devDependencies']) {
  for (const dependency of Object.keys(keysManifest?.[field] ?? {})) {
    if (
      dependency.startsWith('@byok-sdk/') &&
      dependency !== keys[1] &&
      dependency !== '@byok-sdk/core' &&
      dependency !== implementationIdentity[1]
    ) {
      errors.push(`packages/keys/package.json: ${field} crosses into dispatch package ${dependency}`);
    }
  }
}
if (keysManifest?.dependencies?.['@byok-sdk/core'] !== 'workspace:*') {
  errors.push('packages/keys/package.json: @byok-sdk/core must be the one workspace contract dependency');
}
if (Object.keys(keysManifest?.dependencies ?? {}).includes('@byok-sdk/core') === false) {
  errors.push('packages/keys/package.json: @byok-sdk/core dependency is required for the packed metadata edge');
}
if (runtimeEdges(keysManifest ?? {}).includes('@byok-sdk/protocol')) {
  errors.push('packages/keys/package.json: keys must not depend on @byok-sdk/protocol');
}

// These consumers must resolve the same measurement semantics. Packed edges
// are checked from the tarballs by the same guard, not inferred from workspace syntax.
for (const consumer of ['@byok-sdk/client', '@byok-sdk/keys']) {
  try {
    assertImplementationIdentityDependency(manifests.get(consumer), 'workspace:*');
  } catch (error) {
    errors.push(error.message);
  }
}
const identityManifest = manifests.get(implementationIdentity[1]);
for (const dependency of runtimeEdges(identityManifest ?? {})) {
  errors.push(`${implementationIdentity[1]}: measurement package must have no runtime dependency (${dependency})`);
}

const clientManifest = manifests.get('@byok-sdk/client');
if (clientManifest?.optionalDependencies?.[PI_DEPENDENCY_SPECIFIER]) {
  errors.push('packages/client/package.json: pi must be required, not optional');
}
if (
  clientManifest?.exports?.['./adapters']?.import !== './dist/adapters/index.js' ||
  clientManifest?.exports?.['./adapters']?.types !== './dist/adapters/index.d.ts'
) {
  errors.push('packages/client/package.json: adapter-only import/types exports are incomplete');
}
if (
  clientManifest?.exports?.['./agent-memory']?.import !== './dist/agent-memory/index.js' ||
  clientManifest?.exports?.['./agent-memory']?.types !== './dist/agent-memory/index.d.ts'
) {
  errors.push('packages/client/package.json: embedded agent-memory import/types exports are incomplete');
}
if (
  clientManifest?.exports?.['./assertion-client']?.import !== './dist/assertion-client/index.js' ||
  clientManifest?.exports?.['./assertion-client']?.types !== './dist/assertion-client/index.d.ts'
) {
  errors.push('packages/client/package.json: daemon-free assertion-client import/types exports are incomplete');
}
if (
  clientManifest?.exports?.['./mcp-server']?.import !== './dist/mcp-server/index.js' ||
  clientManifest?.exports?.['./mcp-server']?.types !== './dist/mcp-server/index.d.ts'
) {
  errors.push('packages/client/package.json: tools-only MCP server core import/types exports are incomplete');
}

const cloudDataplaneManifest = manifests.get('@byok-sdk/cloud-dataplane');
if (
  cloudDataplaneManifest?.exports?.['./runtime']?.import !== './dist/runtime.js' ||
  cloudDataplaneManifest?.exports?.['./runtime']?.types !== './dist/runtime.d.ts'
) {
  errors.push('packages/cloud-dataplane/package.json: worker runtime subpath import/types exports are incomplete');
}

const clientDirectory = path.join(repoRoot, 'packages/client');
const clientOptionalDependencies = Object.entries(clientManifest?.optionalDependencies ?? {});
const clientTsupConfig = readFileSync(path.join(repoRoot, 'packages/client/tsup.config.ts'), 'utf8');
const clientNoExternal = /noExternal\s*:\s*\[([^\]]*)\]/.exec(clientTsupConfig)?.[1] ?? '';
for (const [dependency, range] of clientOptionalDependencies) {
  if (typeof range !== 'string' || !exactStableVersion.test(range)) {
    errors.push(`packages/client/package.json: optional dependency ${dependency} must be pinned to an exact x.y.z version`);
  }
  if (clientManifest?.dependencies?.[dependency] !== undefined) {
    errors.push(`packages/client/package.json: ${dependency} is both a dependency and an optionalDependency; the platform-required native exception applies to optionalDependencies only`);
  }
  if (clientNoExternal.includes(`'${dependency}'`) || clientNoExternal.includes(`"${dependency}"`)) {
    errors.push(`packages/client/tsup.config.ts: optional dependency ${dependency} must not be inlined by noExternal; it has to stay a runtime resolution`);
  }
  const optionalLabel = `packages/client/package.json: optional dependency ${dependency}`;
  const optionalDirectory = resolvePackageDir(clientDirectory, dependency);
  if (!optionalDirectory) {
    errors.push(`${optionalLabel} could not be resolved under node_modules`);
    continue;
  }
  const violations = auditPackagePurity(optionalLabel, optionalDirectory);
  if (violations.length === 0) continue;
  const justification = OPTIONAL_NATIVE_ALLOWLIST[dependency];
  if (justification === undefined) {
    errors.push(
      ...violations.map(
        (violation) =>
          `${violation} — optionalDependencies is not a free pass for native packages; add ${dependency} to OPTIONAL_NATIVE_ALLOWLIST in this script with a written justification, or drop the dependency`,
      ),
    );
  }
}
for (const dependency of Object.keys(OPTIONAL_NATIVE_ALLOWLIST)) {
  if (clientManifest?.optionalDependencies?.[dependency] === undefined) {
    errors.push(
      `scripts/release/check-package-graph.mjs: OPTIONAL_NATIVE_ALLOWLIST carves out ${dependency}, which is no longer an optionalDependency of packages/client — remove the dead carve-out`,
    );
  }
}

for (const dependency of Object.keys(clientManifest?.dependencies ?? {})) {
  const label = `packages/client/package.json: direct dependency ${dependency}`;
  const dependencyDirectory = resolvePackageDir(clientDirectory, dependency);
  if (!dependencyDirectory) {
    errors.push(`${label} could not be resolved under node_modules`);
    continue;
  }
  errors.push(...auditPackagePurity(label, dependencyDirectory));
}

const scanFiles = [];
const scanRoots = [
  'packages',
  '.github',
  'deploy',
  'examples',
  'templates',
  'docs/spec.md',
  'docs/architecture',
  'docs/protocol.md',
  'docs/security.md',
  'docs/security-review-m5-pilot-entry.md',
  'ARCHITECTURE-PROPOSAL-byok-platform.md',
  'package.json',
  'bun.lock',
  'README.md',
  'CHANGELOG.md',
];
const textExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);

function collect(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) return;
  const stat = statSync(absolutePath);
  if (stat.isDirectory()) {
    const normalizedPath = relativePath.split(path.sep).join('/');
    if (
      ['node_modules', 'dist'].includes(path.basename(relativePath)) ||
      normalizedPath === 'deploy/sql' ||
      normalizedPath === 'docs/architecture/snapshots' ||
      normalizedPath.endsWith('/src/__tests__/golden')
    ) return;
    for (const entry of readdirSync(absolutePath)) collect(path.join(relativePath, entry));
    return;
  }
  if (textExtensions.has(path.extname(relativePath)) || ['package.json', 'bun.lock'].includes(relativePath)) {
    scanFiles.push(relativePath);
  }
}
for (const root of scanRoots) collect(root);
for (const relativePath of scanFiles) {
  if (readFileSync(path.join(repoRoot, relativePath), 'utf8').includes('@byok/')) {
    errors.push(`${relativePath}: contains retired @byok/ package identity`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[release-graph] ${error}`);
  process.exit(1);
}

console.log(`[release-graph] OK: published set is exactly ${publicPackages.length} packages — ${alignedPackages.length} aligned manifests at ${releaseVersion}, keys at ${keysVersion}; ${privatePackages.map(([, name]) => name).join(', ')} private; no aligned package reaches keys`);
