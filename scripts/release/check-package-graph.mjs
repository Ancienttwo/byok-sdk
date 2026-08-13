import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const releaseVersion = '0.3.0';
const keysVersion = '0.1.0';
const piVersion = '0.84.1';
const dispatchPackages = [
  ['packages/core', '@byok-sdk/core'],
  ['packages/protocol', '@byok-sdk/protocol'],
  ['packages/client', '@byok-sdk/client'],
  ['packages/server', '@byok-sdk/server'],
  ['packages/cloud', '@byok-sdk/cloud'],
  ['packages/cloud-dataplane', '@byok-sdk/cloud-dataplane'],
];
const umbrella = ['packages/sdk', 'byok-sdk'];
const keys = ['packages/keys', '@byok-sdk/keys'];
const publicPackages = [...dispatchPackages, umbrella, keys];
const expectedUmbrellaDependencies = dispatchPackages.map(([, name]) => name).sort();
const errors = [];

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
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
  const expectedEngine = expectedName === keys[1] ? '>=20' : '>=22.19.0';
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

for (const [, packageName] of [...dispatchPackages, umbrella]) {
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
    if (dependency.startsWith('@byok-sdk/') && dependency !== keys[1]) {
      errors.push(`packages/keys/package.json: ${field} crosses into dispatch package ${dependency}`);
    }
  }
}

const clientManifest = manifests.get('@byok-sdk/client');
if (clientManifest?.dependencies?.['@earendil-works/pi-coding-agent'] !== piVersion) {
  errors.push(`packages/client/package.json: required pi dependency must be exactly ${piVersion}`);
}
if (clientManifest?.optionalDependencies?.['@earendil-works/pi-coding-agent']) {
  errors.push('packages/client/package.json: pi must be required, not optional');
}
if (
  clientManifest?.exports?.['./adapters']?.import !== './dist/adapters/index.js' ||
  clientManifest?.exports?.['./adapters']?.types !== './dist/adapters/index.d.ts'
) {
  errors.push('packages/client/package.json: adapter-only import/types exports are incomplete');
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
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
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
  if (textExtensions.has(path.extname(relativePath)) || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(relativePath)) {
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
if (conformance.engines?.node !== '>=22.19.0') {
  errors.push('packages/conformance/package.json: engines.node must be >=22.19.0');
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[release-graph] ${error}`);
  process.exit(1);
}

console.log(`[release-graph] OK: ${dispatchPackages.length + 1} dispatch manifests at ${releaseVersion}, keys at ${keysVersion}; umbrella has ${dispatchPackages.length} dispatch namespaces and no keys edge`);
