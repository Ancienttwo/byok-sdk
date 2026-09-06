import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One-command release driver for the fixed-version train: version gate -> build ->
// pack-and-smoke -> publish plan -> registry account gate -> npm publish -> registry
// readback -> annotated tag, so a release is one invocation and one OTP instead of
// eight hand-sequenced commands.
//
// --artifacts <dir> consumes the release-manifest.json that CI packed for the exact
// HEAD: the build and the pack are skipped, every tarball the publish set needs is
// re-hashed against the frozen manifest, and any mismatch aborts. It is mutually
// exclusive with --out-dir, which only relocates a fresh local pack.
//
// Default mode is a dry run: steps 1-4 execute for real and the ordered publish plan
// plus the tag that will follow it are printed, but nothing is published, read back
// or tagged — a readback against unpublished versions can only lie. Steps 5-8 run
// behind --execute and nothing else. The annotated tag is created last, after the
// registry has been read back, so a tag never points at an unpublished train.
//
// Every step is fail-closed: the first failure aborts. There are no retries, no
// partial-success paths, and no alternate route when a precondition is missing.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const packagesDir = path.join(repoRoot, 'packages');

// Package releases accept one exact SemVer identity, including prereleases;
// Pi is deliberately checked separately as a stable exact pin. A prerelease
// is never allowed to inherit npm's implicit latest tag.
export const exactStableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const exactReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const npmSafeDistTag = /^(?=.{1,214}$)[a-z][a-z0-9._-]*$/;

// Versions independently of the release train, so it is compared against its own
// manifest version and never against the shared train version.
const independentPackages = new Set(['@byok-sdk/keys']);

const runtimeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];

const nodeBin = process.execPath;
const npmCliPath = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmInvocation = process.platform === 'win32'
  ? { command: nodeBin, prefix: [npmCliPath] }
  : { command: 'npm', prefix: [] };
if (process.platform === 'win32' && !existsSync(npmCliPath)) {
  throw new Error(`Windows npm CLI entrypoint is missing: ${npmCliPath}`);
}

export function isPrereleaseVersion(version) {
  if (typeof version !== 'string' || !exactReleaseVersion.test(version)) return false;
  return version.slice(0, version.indexOf('+') === -1 ? version.length : version.indexOf('+')).includes('-');
}

export function resolveReleaseDistTag(version, tag) {
  if (typeof version !== 'string' || !exactReleaseVersion.test(version)) {
    throw new Error(`release version must be an exact SemVer version, got ${JSON.stringify(version)}`);
  }
  if (!isPrereleaseVersion(version)) {
    if (tag !== undefined) throw new Error(`stable release ${version} must not set --tag; omit it to retain npm's default latest behavior`);
    return undefined;
  }
  if (typeof tag !== 'string' || !npmSafeDistTag.test(tag) || tag === 'latest') {
    throw new Error(`prerelease ${version} requires a npm-safe non-latest --tag identifier`);
  }
  return tag;
}

/** A prerelease may not resume an interrupted publish; every package must be new. */
export function assertNoPartialPrereleaseRegistryState(entries, registryState, distTag) {
  if (!distTag) return;
  const published = entries.filter((entry) => registryState.get(entry.name));
  if (published.length > 0 && published.length < entries.length) {
    throw new Error(
      `prerelease ${distTag} channel is partially published (${published.map((entry) => entry.name).join(', ')}); ` +
        'refuse automatic continuation — publish a new exact prerelease version instead',
    );
  }
}

export function parseArguments(argv) {
  const parsed = { execute: false, otp: undefined, outDir: undefined, artifacts: undefined, tag: undefined };
  const valueFlags = new Map([
    ['--otp', 'otp'],
    ['--out-dir', 'outDir'],
    ['--artifacts', 'artifacts'],
    ['--tag', 'tag'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') {
      if (seen.has(argument)) throw new Error('--execute may be provided only once');
      seen.add(argument);
      parsed.execute = true;
      continue;
    }
    const destination = valueFlags.get(argument);
    if (!destination) {
      if (argument.startsWith('--')) throw new Error(`unknown flag ${argument}`);
      throw new Error(`unexpected argument ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`${argument} may be provided only once`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    parsed[destination] = value;
    index += 1;
  }
  if (parsed.outDir !== undefined && parsed.artifacts !== undefined) {
    throw new Error(
      '--artifacts and --out-dir are mutually exclusive: --artifacts publishes tarballs that were already packed, ' +
        '--out-dir only chooses where a fresh pack writes them',
    );
  }
  return parsed;
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
    if (typeof manifest.name !== 'string' || !exactReleaseVersion.test(manifest.version ?? '')) {
      throw new Error(`packages/${entry.name}/package.json: a public package needs a name and an exact SemVer version`);
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

/**
 * Verifies a frozen artifact directory against the repository state it claims to
 * describe, and returns the publish plan bound to those exact bytes.
 *
 * The manifest is the only description of what was packed, so every claim it makes is
 * re-checked here: the train version, the commit the artifacts were packed from, and,
 * for every package the publish set still needs, an entry whose version matches, whose
 * tarball is present, and whose bytes hash to the recorded digest. Artifacts for
 * packages that are already on the registry are not part of the publish set and are
 * ignored. Any mismatch is fatal — there is no partial or best-effort acceptance.
 */
export function verifyFrozenArtifacts({ artifactsDir, headSha, trainVersion, publishSet }) {
  const manifestPath = path.join(artifactsDir, 'release-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`frozen artifacts directory carries no release-manifest.json: ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${manifestPath} is not readable JSON: ${error.message}`);
  }
  if (manifest.schemaVersion !== 2) {
    throw new Error(
      `${manifestPath} declares schemaVersion ${JSON.stringify(manifest.schemaVersion ?? null)}; ` +
        'this script and scripts/release/registry-readback.mjs both read schemaVersion 2',
    );
  }
  if (manifest.releaseVersion !== trainVersion) {
    throw new Error(`frozen artifacts are ${manifest.releaseVersion}, the manifests say ${trainVersion}`);
  }
  if (manifest.sourceGitSha !== headSha) {
    throw new Error(`frozen artifacts were packed from ${manifest.sourceGitSha}, HEAD is ${headSha}`);
  }
  if (!Array.isArray(manifest.packages)) {
    throw new Error(`${manifestPath} carries no packages array`);
  }
  const artifacts = new Map(manifest.packages.map((entry) => [entry.package, entry]));
  return publishSet.map((entry) => {
    const artifact = artifacts.get(entry.name);
    if (!artifact) {
      throw new Error(
        `${entry.name}@${entry.version} is unpublished but the frozen artifacts contain nothing for it — ` +
          'pack the release from this commit before publishing it through this script',
      );
    }
    if (artifact.version !== entry.version) {
      throw new Error(`${entry.name}: frozen artifact is ${artifact.version}, the manifest says ${entry.version}`);
    }
    if (typeof artifact.file !== 'string' || artifact.file === '') {
      throw new Error(`${entry.name}: frozen artifact names no file`);
    }
    if (path.basename(artifact.file) !== artifact.file) {
      throw new Error(
        `${entry.name}: frozen artifact file must be a bare filename inside the artifacts directory, got ` +
          `${JSON.stringify(artifact.file)}`,
      );
    }
    const tarballPath = path.join(artifactsDir, artifact.file);
    if (!existsSync(tarballPath)) {
      throw new Error(`${entry.name}: frozen tarball is missing: ${tarballPath}`);
    }
    const digest = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
    if (digest !== artifact.sha256) {
      throw new Error(
        `${entry.name}: ${artifact.file} hashes to sha256 ${digest}, the frozen manifest records ${artifact.sha256}`,
      );
    }
    return { ...entry, file: artifact.file, sha256: artifact.sha256 };
  });
}

/**
 * The registry-side half of the runbook's "provenance/2FA policy" item, made executable:
 * the session must be authenticated, and the account must require a second factor on
 * writes, not only on login. There is no override flag — the policy is the gate.
 */
export function assertRegistryAccountPolicy({ whoami, profile }) {
  if (typeof whoami !== 'string' || whoami.trim() === '') {
    throw new Error('npm reported no authenticated account; authenticate the publishing account before releasing');
  }
  const account = whoami.trim();
  const tfa = profile !== null && typeof profile === 'object' ? profile.tfa : undefined;
  const mode = tfa !== null && typeof tfa === 'object' ? tfa.mode : undefined;
  if (mode !== 'auth-and-writes') {
    throw new Error(
      `npm account ${account} reports tfa.mode ${JSON.stringify(mode ?? null)}; releasing requires ` +
        'tfa.mode "auth-and-writes" on the publishing account (npm profile enable-2fa auth-and-writes)',
    );
  }
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
  const { execute, otp, outDir: requestedOut, artifacts: requestedArtifacts, tag: requestedTag } = parseArguments(process.argv.slice(2));
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
  const distTag = resolveReleaseDistTag(trainVersion, requestedTag);
  for (const entry of manifests.values()) {
    if (isPrereleaseVersion(entry.version) !== Boolean(distTag)) {
      throw new Error(
        `${entry.name}@${entry.version}: every public package must match the release train's prerelease/tag channel`,
      );
    }
  }
  console.log(`[release-publish] step 1/8: release train version ${trainVersion} across ${trainEntries.length} public package(s)`);
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
  assertNoPartialPrereleaseRegistryState([...manifests.values()], registryState, distTag);
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
  const frozen = requestedArtifacts !== undefined;
  if (frozen) {
    console.log('[release-publish] step 2/8: build skipped — --artifacts releases tarballs that are already packed');
  } else {
    console.log('[release-publish] step 2/8: bun run build');
    stream(bunBin, ['run', 'build']);
  }

  // --- Step 3: frozen artifacts, packed here or downloaded from CI ---------
  const ephemeralRoot = frozen || requestedOut ? undefined : mkdtempSync(path.join(os.tmpdir(), 'byok-release-publish-'));
  const outDir = path.resolve(repoRoot, requestedArtifacts ?? requestedOut ?? path.join(ephemeralRoot, 'artifacts'));
  try {
    if (frozen) {
      console.log(`[release-publish] step 3/8: pack skipped — verifying frozen artifacts in ${outDir}`);
    } else {
      console.log(`[release-publish] step 3/8: pack-and-smoke into ${outDir}`);
      stream(nodeBin, ['scripts/release/pack-and-smoke.mjs', '--out-dir', outDir]);
    }

    const releaseManifestPath = path.join(outDir, 'release-manifest.json');
    const headSha = capture('git', ['rev-parse', 'HEAD']);
    const publishSet = topologicalOrder([...manifests.values()].filter((entry) => !registryState.get(entry.name)));
    if (publishSet.length === 0) throw new Error('publish set is empty — nothing to release');
    const plan = verifyFrozenArtifacts({ artifactsDir: outDir, headSha, trainVersion, publishSet });
    console.log(`[release-publish] frozen artifacts verified against ${headSha}`);

    // --- Step 4: publish plan, in dependency order -------------------------
    const tag = `v${trainVersion}`;
    console.log(`[release-publish] step 4/8: publish ${plan.length} package(s) in this order, then tag ${tag}:`);
    for (const [index, entry] of plan.entries()) {
      console.log(`[release-publish]   ${index + 1}. ${entry.name}@${entry.version}  ${entry.file}  sha256:${entry.sha256}`);
    }

    if (!execute) {
      console.log(
        '[release-publish] dry run: steps 5-8 (registry account gate, npm publish, registry readback, git tag) ' +
          'skipped; rerun with --execute to release',
      );
      return;
    }

    // --- Step 5: registry account gate and tag precondition ------------------
    // Everything that can refuse the release runs before the first irreversible
    // action, so a refusal never leaves a half-released train behind.
    console.log('[release-publish] step 5/8: registry account gate');
    const existingTag = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (existingTag.status === 0) throw new Error(`tag ${tag} already exists at ${existingTag.stdout.trim()}`);
    const whoami = capture(npmInvocation.command, [...npmInvocation.prefix, 'whoami']);
    const profileOutput = capture(npmInvocation.command, [...npmInvocation.prefix, 'profile', 'get', '--json']);
    let profile;
    try {
      profile = JSON.parse(profileOutput);
    } catch {
      throw new Error(`npm profile get --json returned unreadable output:\n${profileOutput}`);
    }
    assertRegistryAccountPolicy({ whoami, profile });
    console.log(`[release-publish] npm account ${whoami} requires a second factor on writes`);

    // --- Step 6: publish -----------------------------------------------------
    // Provenance attestations are signed from the GitHub OIDC token, so the flag is
    // only meaningful inside GitHub Actions; a local release says so instead.
    const attestProvenance = process.env.GITHUB_ACTIONS === 'true';
    if (!attestProvenance) {
      console.log('[release-publish] provenance is not attached: attestations need GitHub Actions OIDC and this is not a GitHub Actions run');
    }
    console.log(`[release-publish] step 6/8: npm publish ${plan.length} tarball(s)`);
    for (const entry of plan) {
      stream(npmInvocation.command, [
        ...npmInvocation.prefix,
        'publish',
        path.join(outDir, entry.file),
        '--access',
        'public',
        ...(attestProvenance ? ['--provenance'] : []),
        ...(distTag ? ['--tag', distTag] : []),
        ...(otp ? ['--otp', otp] : []),
      ]);
      console.log(`[release-publish] published ${entry.name}@${entry.version}`);
    }

    // --- Step 7: registry readback ------------------------------------------
    console.log('[release-publish] step 7/8: registry readback');
    stream(nodeBin, [
      'scripts/release/registry-readback.mjs',
      '--manifest',
      releaseManifestPath,
      ...(distTag ? ['--tag', distTag] : []),
    ]);

    // --- Step 8: annotated tag ----------------------------------------------
    // Last, and only once the registry itself confirms the train: a tag created any
    // earlier can outlive a failed publish and name a release that does not exist.
    console.log(`[release-publish] step 8/8: git tag -a ${tag}`);
    capture('git', ['tag', '-a', tag, '-m', `${tag}\n\nsourceGitSha ${headSha}`]);
    console.log(`[release-publish] OK: ${plan.length} package(s) published, read back and tagged ${tag}`);
  } finally {
    if (ephemeralRoot) rmSync(ephemeralRoot, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
