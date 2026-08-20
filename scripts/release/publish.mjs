import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One-command release driver for the fixed-version train: version gate -> build ->
// pack-and-smoke -> publish plan -> tag -> npm publish -> registry readback, so a
// release is one invocation and one OTP instead of seven hand-sequenced commands.
//
// Default mode is a dry run: steps 1-4 execute for real (including the build and the
// full pack-and-smoke gate) and the tag plus the ordered publish plan are printed,
// but nothing is tagged or published and the readback is skipped — a readback against
// unpublished versions can only lie. Steps 5-7 run behind --execute and nothing else.
//
// Every step is fail-closed: the first failure aborts. There are no retries, no
// partial-success paths, and no alternate route when a precondition is missing.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const packagesDir = path.join(repoRoot, 'packages');
const exactVersion = /^\d+\.\d+\.\d+$/;

// Versions independently of the release train, so it is compared against its own
// manifest version and never against the shared train version.
const independentPackages = new Set(['@byok-sdk/keys']);

const runtimeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const knownFlags = new Set(['--execute', '--otp', '--out-dir']);

const nodeBin = process.execPath;
const npmCliPath = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmInvocation = process.platform === 'win32'
  ? { command: nodeBin, prefix: [npmCliPath] }
  : { command: 'npm', prefix: [] };
if (process.platform === 'win32' && !existsSync(npmCliPath)) {
  throw new Error(`Windows npm CLI entrypoint is missing: ${npmCliPath}`);
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

/** Captures a command's output; a non-zero exit is a hard failure, never a signal to branch. */
function capture(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Streams a long-running step's output so the operator sees it live. */
function stream(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

/** Reads every public workspace manifest under packages/, keyed by package name. */
export function readPublicManifests(directory) {
  const manifests = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(directory, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private === true) continue;
    if (typeof manifest.name !== 'string' || !exactVersion.test(manifest.version ?? '')) {
      throw new Error(`packages/${entry.name}/package.json: a public package needs a name and an exact x.y.z version`);
    }
    manifests.set(manifest.name, { name: manifest.name, version: manifest.version, directory: `packages/${entry.name}`, manifest });
  }
  if (manifests.size === 0) throw new Error(`no public packages found under ${directory}`);
  return manifests;
}

/**
 * Orders a package set so every dependency publishes before its dependents. Edges come
 * from runtime dependency fields restricted to the set itself; ties break alphabetically
 * so the plan a dry run prints is the plan --execute follows. A cycle is unpublishable.
 */
export function topologicalOrder(entries) {
  const names = new Set(entries.map((entry) => entry.name));
  const pending = new Map();
  for (const entry of entries) {
    const dependencies = new Set(
      runtimeFields
        .flatMap((field) => Object.keys(entry.manifest[field] ?? {}))
        .filter((dependency) => names.has(dependency) && dependency !== entry.name),
    );
    pending.set(entry.name, dependencies);
  }
  const ordered = [];
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(`dependency cycle among publishable packages: ${[...pending.keys()].sort().join(', ')}`);
    }
    for (const name of ready) {
      ordered.push(byName.get(name));
      pending.delete(name);
    }
    for (const dependencies of pending.values()) {
      for (const name of ready) dependencies.delete(name);
    }
  }
  return ordered;
}

/** True when name@version is already on the registry. Anything other than a clean hit or a clean 404 aborts. */
function isPublished(name, version) {
  const result = spawnSync(
    npmInvocation.command,
    [...npmInvocation.prefix, 'view', `${name}@${version}`, 'version', '--json'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm view ${name}@${version} returned unreadable output (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  if (result.status === 0) {
    if (payload === version) return true;
    throw new Error(`npm view ${name}@${version} reported version ${JSON.stringify(payload)}`);
  }
  if (payload?.error?.code === 'E404') return false;
  throw new Error(`npm view ${name}@${version} failed (${result.status})\n${result.stderr}`);
}

async function main() {
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    if (!knownFlags.has(argument)) throw new Error(`unknown flag ${argument}`);
    if (argument !== '--execute') index += 1;
  }
  const execute = argv.includes('--execute');
  const otp = flagValue(argv, '--otp');
  const requestedOut = flagValue(argv, '--out-dir');
  if (otp && !execute) throw new Error('--otp is only meaningful with --execute');

  // --- Step 1: version consistency + registry candidacy -------------------
  const manifests = readPublicManifests(packagesDir);
  const trainEntries = [...manifests.values()].filter((entry) => !independentPackages.has(entry.name));
  if (trainEntries.length === 0) throw new Error('no release-train packages found');
  const trainVersion = trainEntries[0].version;
  const desynced = trainEntries.filter((entry) => entry.version !== trainVersion);
  if (desynced.length > 0) {
    throw new Error(
      `release train versions are split: expected every public package at ${trainVersion}, but ` +
        desynced.map((entry) => `${entry.directory} is ${entry.version}`).join(', '),
    );
  }
  console.log(`[release-publish] step 1/7: release train version ${trainVersion} across ${trainEntries.length} public package(s)`);
  for (const entry of manifests.values()) {
    if (independentPackages.has(entry.name)) console.log(`[release-publish] ${entry.name} versions independently at ${entry.version}`);
  }

  // A version that is already fully on the registry is a released version, not a
  // candidate: republishing it is impossible and re-tagging it is a lie. A version
  // only partially on the registry is the current candidate — a release interrupted
  // between publishes — and the remaining packages are exactly the publish set.
  const registryState = new Map();
  for (const entry of manifests.values()) {
    registryState.set(entry.name, isPublished(entry.name, entry.version));
  }
  const trainPublished = trainEntries.filter((entry) => registryState.get(entry.name));
  if (trainPublished.length === trainEntries.length) {
    throw new Error(`release train version ${trainVersion} is already published for every public package — bump the version before releasing`);
  }
  if (trainPublished.length > 0) {
    console.log(
      `[release-publish] ${trainVersion} is a partially published candidate; already on the registry: ` +
        trainPublished.map((entry) => entry.name).join(', '),
    );
  }

  // --- Step 2: build -------------------------------------------------------
  const bunBin = process.platform === 'win32' ? 'bun.exe' : 'bun';
  console.log('[release-publish] step 2/7: bun run build');
  stream(bunBin, ['run', 'build']);

  // --- Step 3: pack and smoke ---------------------------------------------
  const ephemeralRoot = requestedOut ? undefined : mkdtempSync(path.join(os.tmpdir(), 'byok-release-publish-'));
  const outDir = path.resolve(repoRoot, requestedOut ?? path.join(ephemeralRoot, 'artifacts'));
  try {
    console.log(`[release-publish] step 3/7: pack-and-smoke into ${outDir}`);
    stream(nodeBin, ['scripts/release/pack-and-smoke.mjs', '--out-dir', outDir]);

    const releaseManifestPath = path.join(outDir, 'release-manifest.json');
    if (!existsSync(releaseManifestPath)) throw new Error(`pack-and-smoke produced no ${releaseManifestPath}`);
    const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, 'utf8'));
    if (releaseManifest.releaseVersion !== trainVersion) {
      throw new Error(`frozen artifacts are ${releaseManifest.releaseVersion}, the manifests say ${trainVersion}`);
    }
    const headSha = capture('git', ['rev-parse', 'HEAD']);
    if (releaseManifest.sourceGitSha !== headSha) {
      throw new Error(`frozen artifacts were packed from ${releaseManifest.sourceGitSha}, HEAD is ${headSha}`);
    }
    const artifacts = new Map(releaseManifest.packages.map((entry) => [entry.package, entry]));

    // --- Step 4: publish set, in dependency order --------------------------
    const publishSet = topologicalOrder([...manifests.values()].filter((entry) => !registryState.get(entry.name)));
    if (publishSet.length === 0) throw new Error('publish set is empty — nothing to release');
    const plan = publishSet.map((entry) => {
      const artifact = artifacts.get(entry.name);
      if (!artifact) {
        throw new Error(
          `${entry.name}@${entry.version} is unpublished but pack-and-smoke froze no artifact for it — ` +
            'add it to the pack-and-smoke package set before releasing it through this script',
        );
      }
      if (artifact.version !== entry.version) {
        throw new Error(`${entry.name}: frozen artifact is ${artifact.version}, the manifest says ${entry.version}`);
      }
      return { ...entry, file: artifact.file, sha256: artifact.sha256 };
    });

    const tag = `v${trainVersion}`;
    console.log(`[release-publish] step 4/7: git tag ${tag} and publish ${plan.length} package(s) in this order:`);
    for (const [index, entry] of plan.entries()) {
      console.log(`[release-publish]   ${index + 1}. ${entry.name}@${entry.version}  ${entry.file}  sha256:${entry.sha256}`);
    }

    if (!execute) {
      console.log('[release-publish] dry run: steps 5-7 (tag, publish, registry readback) skipped; rerun with --execute to release');
      return;
    }

    // --- Step 5: annotated tag ----------------------------------------------
    const existingTag = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (existingTag.status === 0) throw new Error(`tag ${tag} already exists at ${existingTag.stdout.trim()}`);
    console.log(`[release-publish] step 5/7: git tag -a ${tag}`);
    capture('git', ['tag', '-a', tag, '-m', `${tag}\n\nsourceGitSha ${headSha}`]);

    // --- Step 6: publish -----------------------------------------------------
    console.log(`[release-publish] step 6/7: npm publish ${plan.length} tarball(s)`);
    for (const entry of plan) {
      const tarball = path.join(outDir, entry.file);
      if (!existsSync(tarball)) throw new Error(`frozen tarball is missing: ${tarball}`);
      stream(npmInvocation.command, [
        ...npmInvocation.prefix,
        'publish',
        tarball,
        '--access',
        'public',
        ...(otp ? ['--otp', otp] : []),
      ]);
      console.log(`[release-publish] published ${entry.name}@${entry.version}`);
    }

    // --- Step 7: registry readback ------------------------------------------
    console.log('[release-publish] step 7/7: registry readback');
    stream(nodeBin, ['scripts/release/registry-readback.mjs', '--manifest', releaseManifestPath]);
    console.log(`[release-publish] OK: ${tag} tagged and ${plan.length} package(s) published and read back`);
  } finally {
    if (ephemeralRoot) rmSync(ephemeralRoot, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
