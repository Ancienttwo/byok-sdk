import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const testkit = ['packages/testkit', '@byok-sdk/testkit'];
const umbrella = ['packages/sdk', 'byok-sdk'];
const keys = ['packages/keys', '@byok-sdk/keys'];
// testkit ships independently of the umbrella's public namespaces, but it is
// still part of the aligned release graph and must not escape the train check.
const alignedPackages = [...dispatchPackages, testkit];
const publicPackages = [...alignedPackages, umbrella, keys];
const expectedUmbrellaDependencies = dispatchPackages.map(([, name]) => name).sort();
const errors = [];

// @byok-sdk/client must install as pure JavaScript: a direct dependency that ships a prebuilt
// `.node` addon or runs an install script turns an end user's install into a compile/download step
// and breaks the SEA/bun single-file packagability invariant. Direct dependencies only — the
// transitive closure is deliberately out of scope, since scoping it would require an allowlist.
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
// part of the SDK release channel.
const exactStableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const exactReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const releaseVersion = readJson('packages/core/package.json').version;
const keysVersion = readJson('packages/keys/package.json').version;
const piVersion = readJson('packages/client/package.json').dependencies?.['@earendil-works/pi-coding-agent'];
if (typeof releaseVersion !== 'string' || !exactReleaseVersion.test(releaseVersion)) {
  errors.push('packages/core/package.json: version must be an exact SemVer release train version');
}
if (typeof keysVersion !== 'string' || !exactReleaseVersion.test(keysVersion)) {
  errors.push('packages/keys/package.json: version must be an exact SemVer version');
}
if (keysVersion === releaseVersion) {
  errors.push(`packages/keys/package.json: keys must remain independently versioned from the ${releaseVersion} dispatch train`);
}
if (typeof piVersion !== 'string' || !exactStableVersion.test(piVersion)) {
  errors.push('packages/client/package.json: @earendil-works/pi-coding-agent must be pinned to an exact x.y.z version');
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

/** Parses bun.lock, which is JSONC-like: trailing commas are legal and must be dropped before JSON.parse. */
function parseLockfile(text) {
  let cleaned = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      cleaned += character;
      index += 1;
      while (index < text.length) {
        cleaned += text[index];
        if (text[index] === '\\') {
          index += 1;
          cleaned += text[index] ?? '';
        } else if (text[index] === '"') {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === '}' || text[lookahead] === ']') continue;
    }
    cleaned += character;
  }
  return JSON.parse(cleaned);
}

const lockfileText = readFileSync(path.join(repoRoot, 'bun.lock'), 'utf8');
let workspaceRecords;
try {
  workspaceRecords = parseLockfile(lockfileText).workspaces ?? {};
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
for (const directory of [...dispatchPackages.map(([dir]) => dir), 'packages/sdk', 'packages/testkit', keys[0]]) {
  if (!workspaceRecords[directory]) {
    errors.push(`bun.lock: missing workspace record for ${directory} — bun pm pack cannot resolve its workspace edges without it`);
  }
}

const umbrellaManifest = manifests.get('byok-sdk');
const umbrellaDependencies = Object.keys(umbrellaManifest?.dependencies ?? {}).sort();
if (JSON.stringify(umbrellaDependencies) !== JSON.stringify(expectedUmbrellaDependencies)) {
  errors.push(`packages/sdk/package.json: umbrella dependencies must be exactly ${expectedUmbrellaDependencies.join(', ')}`);
}
for (const dependency of umbrellaDependencies) {
  if (umbrellaManifest.dependencies[dependency] !== 'workspace:*') {
    errors.push(`packages/sdk/package.json: ${dependency} must use workspace:* before packing`);
  }
}

const runtimeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
function runtimeEdges(manifest) {
  return runtimeFields.flatMap((field) => Object.keys(manifest[field] ?? {}));
}

for (const [, packageName] of [...alignedPackages, umbrella]) {
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
      dependency !== '@byok-sdk/core'
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

const clientManifest = manifests.get('@byok-sdk/client');
if (clientManifest?.optionalDependencies?.['@earendil-works/pi-coding-agent']) {
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

const cloudDataplaneManifest = manifests.get('@byok-sdk/cloud-dataplane');
if (
  cloudDataplaneManifest?.exports?.['./runtime']?.import !== './dist/runtime.js' ||
  cloudDataplaneManifest?.exports?.['./runtime']?.types !== './dist/runtime.d.ts'
) {
  errors.push('packages/cloud-dataplane/package.json: worker runtime subpath import/types exports are incomplete');
}

const clientDirectory = path.join(repoRoot, 'packages/client');
for (const dependency of Object.keys(clientManifest?.dependencies ?? {})) {
  const label = `packages/client/package.json: direct dependency ${dependency}`;
  const dependencyDirectory = resolvePackageDir(clientDirectory, dependency);
  if (!dependencyDirectory) {
    errors.push(`${label} could not be resolved under node_modules`);
    continue;
  }
  errors.push(...auditPackagePurity(label, dependencyDirectory));
}

const umbrellaSource = readFileSync(path.join(repoRoot, 'packages/sdk/src/index.ts'), 'utf8');
for (const [, packageName] of dispatchPackages) {
  if (!umbrellaSource.includes(`from '${packageName}'`)) errors.push(`packages/sdk/src/index.ts: missing ${packageName} namespace`);
}
if (/from\s+['"]@byok-sdk\/keys['"]/.test(umbrellaSource) || /export\s+\*\s+as\s+keys\b/.test(umbrellaSource)) {
  errors.push(`packages/sdk/src/index.ts: keys must not be exported`);
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

const conformance = readJson('packages/conformance/package.json');
if (conformance.name !== '@byok-sdk/conformance' || conformance.private !== true) {
  errors.push('packages/conformance/package.json: conformance must remain private @byok-sdk/conformance');
}
if (conformance.engines?.node !== '>=22.22.0') {
  errors.push('packages/conformance/package.json: engines.node must be >=22.22.0');
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[release-graph] ${error}`);
  process.exit(1);
}

console.log(`[release-graph] OK: ${alignedPackages.length + 1} aligned manifests at ${releaseVersion}, keys at ${keysVersion}; umbrella has ${dispatchPackages.length} dispatch namespaces and no keys edge`);
