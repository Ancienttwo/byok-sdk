import { assertFrozenRegistryExpectations, assertPrereleaseRegistryBaseline, frozenRuntimeDependencyMetadata, npmDistTags, npmPackageExists, npmView, readRegistryExpectations } from './registry-contract.mjs';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { iterateTarballFiles } from './pi-runtime-identity.mjs';
import { runtimeDependencyMetadata } from './registry-contract.mjs';
import { fetchReleaseArtifact } from '../ci/release-artifact.mjs';

// One-command release driver for the fixed-version train: version gate -> build ->
// pack-and-smoke -> publish plan -> registry auth gate -> npm publish -> registry
// readback -> annotated tag, so a release is one invocation instead of eight
// hand-sequenced commands.
//
// Every --execute requires --ci-run-id, --ci-artifact-id and --ci-artifact-digest.
// The driver verifies GitHub metadata for HEAD, downloads the accepted ZIP itself,
// authenticates its digest and publishes those bytes without building or packing.
// --artifacts <dir> and --out-dir are dry-run inputs only; a local manifest or
// receipt is never release authorization.
//
// Default mode is a dry run (--dry-run says so explicitly): steps 1-4 execute for
// real and the full release plan is printed — every package with its action, the
// auth mode, provenance, dist-tag, readback schedule and the tag that follows —
// but nothing is published, read back or tagged. Steps 5-8 run behind --execute
// and nothing else. The annotated tag is created last, after the registry has been
// read back, so a tag never points at an unpublished train.
//
// --trusted-publishing authenticates through npm trusted publishing (GitHub Actions
// OIDC) instead of an npm session and OTP; see docs/releases/oidc-trusted-publishing.md.
//
// Writes are fail-closed and never retried. A run converges instead: a package the
// registry already holds with the frozen integrity is skipped, a failed publish
// whose upload landed anyway is accepted only on the frozen integrity, and a re-run
// of the same command resumes from the first package that is not on the registry —
// or, when every package is published but the tag is missing, from the readback.
// Only registry reads wait: npm can 404 a version it accepted for minutes
// (v0.23.0, v0.26.0), so the readback polls on a bounded backoff before it fails.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const packagesDir = path.join(repoRoot, 'packages');

// Package releases accept one exact SemVer identity, including prereleases;
// Pi is deliberately checked separately as a stable exact pin. A prerelease
// is never allowed to inherit npm's implicit latest tag.
export const exactStableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const exactReleaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const npmSafeDistTag = /^(?=.{1,214}$)[a-z][a-z0-9._-]*$/;

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

/** Refresh after preparation. This narrows the race window; npm writes are not transactional. */
export function assertPrereleaseReadyToPublish(entries, expectations, distTag, registry) {
  if (!distTag) return;
  for (const entry of entries) {
    if (registry.isPublished(entry.name, entry.version)) {
      throw new Error(`${entry.name}@${entry.version}: prerelease registry state changed before publication; prepare a new exact prerelease`);
    }
  }
  assertPrereleaseRegistryBaseline(entries, expectations, distTag, registry);
}

export function parseArguments(argv) {
  const parsed = {
    execute: false, otp: undefined, outDir: undefined, artifacts: undefined, tag: undefined, trustedPublishing: false,
  };
  const valueFlags = new Map([
    ['--otp', 'otp'],
    ['--out-dir', 'outDir'],
    ['--artifacts', 'artifacts'],
    ['--tag', 'tag'],
    ['--ci-run-id', 'ciRunId'],
    ['--ci-artifact-id', 'ciArtifactId'],
    ['--ci-artifact-digest', 'ciArtifactDigest'],
  ]);
  const switches = new Map([
    ['--execute', 'execute'],
    ['--trusted-publishing', 'trustedPublishing'],
    ['--dry-run', undefined],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (switches.has(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} may be provided only once`);
      seen.add(argument);
      const destination = switches.get(argument);
      if (destination) parsed[destination] = true;
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
  if (seen.has('--dry-run') && parsed.execute) {
    throw new Error('--dry-run and --execute are mutually exclusive: a dry run prints the plan, --execute releases it');
  }
  if (parsed.trustedPublishing && parsed.otp !== undefined) {
    throw new Error('--otp has no meaning with --trusted-publishing: OIDC publishing carries no one-time password');
  }
  if (parsed.outDir !== undefined && parsed.artifacts !== undefined) {
    throw new Error(
      '--artifacts and --out-dir are mutually exclusive: --artifacts publishes tarballs that were already packed, ' +
        '--out-dir only chooses where a fresh pack writes them',
    );
  }
  const hasCI = [parsed.ciRunId, parsed.ciArtifactId, parsed.ciArtifactDigest].some(value => value !== undefined);
  if (parsed.execute && !hasCI) {
    throw Object.assign(new Error('--execute requires --ci-run-id, --ci-artifact-id and --ci-artifact-digest; local artifacts cannot authorize publication'), { code: 'RELEASE_CI_EVIDENCE_REQUIRED' });
  }
  if (hasCI) {
    if (!/^[1-9]\d*$/.test(parsed.ciRunId ?? '') || !Number.isSafeInteger(Number(parsed.ciRunId))
      || !/^[1-9]\d*$/.test(parsed.ciArtifactId ?? '') || !Number.isSafeInteger(Number(parsed.ciArtifactId))
      || !/^sha256:[a-f0-9]{64}$/.test(parsed.ciArtifactDigest ?? '')) {
      throw new Error('Provide all CI evidence flags with exact positive run/artifact IDs and a sha256 artifact digest');
    }
    if (parsed.artifacts !== undefined || parsed.outDir !== undefined) {
      throw new Error('CI evidence cannot be combined with --artifacts or --out-dir; accepted bytes are downloaded directly from GitHub');
    }
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
  if (manifest.schemaVersion !== 3) {
    throw new Error(
      `${manifestPath} declares schemaVersion ${JSON.stringify(manifest.schemaVersion ?? null)}; ` +
        'this script and scripts/release/registry-readback.mjs both read schemaVersion 3',
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
    const tarballBytes = readFileSync(tarballPath);
    const digest = createHash('sha256').update(tarballBytes).digest('hex');
    if (digest !== artifact.sha256) {
      throw new Error(
        `${entry.name}: ${artifact.file} hashes to sha256 ${digest}, the frozen manifest records ${artifact.sha256}`,
      );
    }
    const frozenDependencies = frozenRuntimeDependencyMetadata(artifact, entry.name);
    const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;
    if (artifact.sha512Integrity !== integrity) throw new Error(`${entry.name}: frozen SHA-512 integrity differs from tarball bytes`);
    const manifests = [...iterateTarballFiles(tarballPath)].filter(([name]) => name === 'package/package.json');
    if (manifests.length !== 1) throw new Error(`${entry.name}: frozen tarball must contain exactly one package/package.json`);
    const packedManifest = JSON.parse(manifests[0][1].toString('utf8'));
    if (packedManifest.name !== entry.name || packedManifest.version !== entry.version) {
      throw new Error(`${entry.name}: frozen tarball package identity/version mismatch`);
    }
    if (!isDeepStrictEqual(frozenDependencies, runtimeDependencyMetadata(packedManifest, `${entry.name} packed manifest`))) {
      throw new Error(`${entry.name}: frozen dependency metadata differs from tarball bytes`);
    }
    return { ...entry, file: artifact.file, sha256: artifact.sha256, sha512Integrity: artifact.sha512Integrity };
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

// npm trusted publishing needs npm 11.5.1 or later; older clients never ask for the OIDC token.
const trustedPublishingNpm = [11, 5, 1];
const longLivedTokenVariables = ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_CONFIG__AUTHTOKEN', 'npm_config__authToken'];

/**
 * The --trusted-publishing half of the auth gate. npm accepts OIDC publishing from
 * GitHub-hosted runners only, and only when the job may mint an ID token. A
 * long-lived token in the environment is refused: npm would fall back to it, and the
 * point of the mode is that no publish credential outlives the job.
 */
export function assertTrustedPublishingEnvironment({ env, npmVersion }) {
  if (env.GITHUB_ACTIONS !== 'true') {
    throw new Error('--trusted-publishing needs a GitHub Actions run: npm trusts the OIDC identity of a GitHub workflow, not a local shell');
  }
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error(
      `--trusted-publishing needs a GitHub-hosted runner, this runner reports RUNNER_ENVIRONMENT=${JSON.stringify(env.RUNNER_ENVIRONMENT ?? null)}; ` +
        'npm does not accept OIDC publishing from self-hosted runners',
    );
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('--trusted-publishing found no OIDC token endpoint; the publishing job needs `permissions: id-token: write`');
  }
  const present = longLivedTokenVariables.filter((name) => typeof env[name] === 'string' && env[name] !== '');
  if (present.length > 0) {
    throw new Error(`--trusted-publishing refuses a long-lived npm token in the environment (${present.join(', ')}); remove it from the job`);
  }
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof npmVersion === 'string' ? npmVersion.trim() : '');
  const difference = match
    ? match.slice(1).map((part, index) => Number(part) - trustedPublishingNpm[index]).find((delta) => delta !== 0) ?? 0
    : -1;
  if (difference < 0) {
    throw new Error(`--trusted-publishing needs npm ${trustedPublishingNpm.join('.')} or later, found ${JSON.stringify(npmVersion ?? null)}`);
  }
}

// Registry reads lag registry writes. These schedules bound every wait; writes have none.
// Total waits: about 3 minutes for visibility (v0.26.0 needed about 2), 35 seconds
// to see whether a failed upload landed, and under 3 minutes of readback retries.
export const registryVisibilityDelaysMs = Object.freeze([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
export const publishLandedDelaysMs = Object.freeze([5_000, 10_000, 20_000]);
export const readbackRetryDelaysMs = Object.freeze([15_000, 30_000, 60_000, 60_000]);

export const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

function seconds(milliseconds) {
  return `${milliseconds / 1000}s`;
}

/** Calls `probe` until it returns something other than undefined; undefined once the schedule is spent. */
export async function pollRegistry(probe, { delays, sleep: wait }) {
  for (let attempt = 0; ; attempt += 1) {
    const value = probe();
    if (value !== undefined) return value;
    if (attempt >= delays.length) return undefined;
    await wait(delays[attempt]);
  }
}

function assertFrozenIntegrity(entry, integrity) {
  if (integrity !== entry.sha512Integrity) {
    throw new Error(
      `${entry.name}@${entry.version}: the registry holds integrity ${JSON.stringify(integrity)}, the frozen artifact is ` +
        `${entry.sha512Integrity} — these are not the frozen bytes; stop and investigate before releasing anything else`,
    );
  }
}

/**
 * A package counts as already released only when the registry holds the bytes this
 * release froze. Every already-published package is read back by exact version before
 * the plan is printed, so a frozen pack that is a different build of a published
 * version (an unbumped train, a stale artifact) fails here, in a dry run as well.
 */
export async function assertPublishedMatchFrozen({ entries, frozenManifest, readIntegrity, sleep: wait, delays = publishLandedDelaysMs }) {
  const artifacts = new Map((Array.isArray(frozenManifest?.packages) ? frozenManifest.packages : []).map((artifact) => [artifact.package, artifact]));
  for (const entry of entries) {
    const artifact = artifacts.get(entry.name);
    if (!artifact || artifact.version !== entry.version) {
      throw new Error(`${entry.name}@${entry.version} is on the registry but the frozen artifacts carry no ${entry.version} entry for it`);
    }
    const integrity = await pollRegistry(() => readIntegrity(entry), { delays, sleep: wait });
    if (integrity === undefined) {
      throw new Error(`${entry.name}@${entry.version}: the registry stopped serving a version it reported as published; re-run once it is visible`);
    }
    assertFrozenIntegrity({ ...entry, sha512Integrity: artifact.sha512Integrity }, integrity);
  }
}

/**
 * Publishes the plan in order. `readIntegrity(entry)` returns the registry's
 * dist.integrity for the exact version, or undefined on E404; `publishTarball(entry)`
 * performs one upload and throws on failure. A version the registry already holds is
 * skipped on the frozen integrity and aborts on any other. A failed upload is accepted
 * only when the registry then shows the frozen integrity (npm can report failure for
 * an upload that landed — v0.23.0). A failed upload that did not land stops the run:
 * re-running the same command resumes from that package.
 */
export async function publishPlan({
  plan, publishTarball, readIntegrity, sleep: wait, log, landedDelays = publishLandedDelaysMs, prerelease = false,
}) {
  const outcome = { published: [], skipped: [] };
  for (const entry of plan) {
    const existing = readIntegrity(entry);
    if (existing !== undefined) {
      assertFrozenIntegrity(entry, existing);
      outcome.skipped.push(entry.name);
      log(`skipped ${entry.name}@${entry.version}: already on the registry with the frozen integrity`);
      continue;
    }
    try {
      publishTarball(entry);
    } catch (error) {
      const publishError = error instanceof Error ? error.message : String(error);
      let landed;
      try {
        landed = await pollRegistry(() => readIntegrity(entry), { delays: landedDelays, sleep: wait });
      } catch (readError) {
        throw new Error(
          `${entry.name}@${entry.version}: npm publish failed and the registry read that followed failed too ` +
            `(${readError instanceof Error ? readError.message : String(readError)})\n${publishError}`,
        );
      }
      if (landed === undefined) {
        const done = outcome.published.length + outcome.skipped.length;
        const next = prerelease
          ? 'a partially published prerelease does not resume; prepare a new exact prerelease version'
          : `re-run the same command to resume from ${entry.name}`;
        throw new Error(
          `${entry.name}@${entry.version}: npm publish failed and the registry does not hold this version ` +
            `(${done} of ${plan.length} planned package(s) are on the registry); ${next}\n${publishError}`,
        );
      }
      assertFrozenIntegrity(entry, landed);
      log(`${entry.name}@${entry.version}: npm publish reported a failure, but the registry holds the frozen bytes`);
    }
    outcome.published.push(entry.name);
    log(`published ${entry.name}@${entry.version}`);
  }
  return outcome;
}

/**
 * Waits until the registry serves every exact version of the train. An E404 is the
 * only answer that waits; `isPublished` throws on anything else and that aborts.
 */
export async function waitForRegistryVisibility({ entries, isPublished: published, sleep: wait, log, delays = registryVisibilityDelaysMs }) {
  let pending = entries;
  for (let attempt = 0; ; attempt += 1) {
    pending = pending.filter((entry) => !published(entry.name, entry.version));
    if (pending.length === 0) return attempt + 1;
    const names = pending.map((entry) => `${entry.name}@${entry.version}`).join(', ');
    if (attempt >= delays.length) {
      throw new Error(
        `the registry still answers E404 for ${names} after ${attempt + 1} probe(s); nothing was tagged — ` +
          're-run the same command later to resume from the readback',
      );
    }
    log(`waiting ${seconds(delays[attempt])} for registry propagation of ${names}`);
    await wait(delays[attempt]);
  }
}

/**
 * Runs the full readback, retrying on the bounded schedule. Every failure is retried,
 * not only E404: the readback also installs from the registry, whose CDN can serve a
 * stale packument after the exact-version reads already agree. A real mismatch still
 * fails, after the schedule.
 */
export async function readbackWithRetry({ readback, sleep: wait, log, delays = readbackRetryDelaysMs }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      readback();
      return attempt + 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= delays.length) {
        throw new Error(
          `registry readback failed after ${attempt + 1} attempt(s); nothing was tagged — re-run the same command ` +
            `to resume from the readback\n${message}`,
        );
      }
      log(`readback attempt ${attempt + 1} failed (${message.split('\n')[0]}); retrying in ${seconds(delays[attempt])}`);
      await wait(delays[attempt]);
    }
  }
}

/** The complete plan a dry run prints and --execute follows. */
export function describeReleasePlan({ entries, plan, registryState, tag, distTag, trustedPublishing, provenance }) {
  const lines = [];
  if (plan.length === 0) {
    lines.push(`nothing to publish: every package is already on the registry; this run resumes with the readback and tag ${tag}`);
  } else {
    lines.push(`publish ${plan.length} package(s) in this order:`);
    for (const [index, entry] of plan.entries()) {
      lines.push(`  ${index + 1}. ${entry.name}@${entry.version}  ${entry.file}  sha256:${entry.sha256}`);
    }
  }
  const skipped = entries.filter((entry) => registryState.get(entry.name));
  if (skipped.length > 0) {
    lines.push(`skip ${skipped.length} package(s) already on the registry:`);
    for (const entry of skipped) lines.push(`  - ${entry.name}@${entry.version}`);
  }
  lines.push(trustedPublishing
    ? 'auth: npm trusted publishing (GitHub Actions OIDC); no token, no OTP'
    : 'auth: the local npm session; tfa.mode auth-and-writes is required');
  lines.push(provenance ? 'provenance: attached (--provenance)' : 'provenance: not attached (not a GitHub Actions run)');
  lines.push(`dist-tag: ${distTag ?? 'latest (npm default)'}`);
  const visibility = registryVisibilityDelaysMs.reduce((total, delay) => total + delay, 0);
  lines.push(
    `readback: wait up to ${seconds(visibility)} for all ${entries.length} exact versions, then the full readback with ` +
      `up to ${readbackRetryDelaysMs.length} retr${readbackRetryDelaysMs.length === 1 ? 'y' : 'ies'}`,
  );
  lines.push(`tag: annotated ${tag} at HEAD, created only after the readback passes`);
  return lines;
}

function view(selector, fields, allowNotFound = false) {
  return npmView({ invocation: npmInvocation, cwd: repoRoot, selector, fields, allowNotFound });
}

/** True when name@version is already on the registry. Anything other than a clean hit or a clean 404 aborts. */
function isPublished(name, version) {
  const result = view(`${name}@${version}`, ['version'], true);
  if (!result.found) return false;
  if (result.value === version) return true;
  throw new Error(`npm view ${name}@${version} reported version ${JSON.stringify(result.value)}`);
}

/** The registry's dist.integrity for name@version, or undefined on a clean 404. */
function publishedIntegrity(name, version) {
  const result = view(`${name}@${version}`, ['dist.integrity'], true);
  if (!result.found) return undefined;
  if (typeof result.value !== 'string' || result.value === '') {
    throw new Error(`npm view ${name}@${version} dist.integrity reported ${JSON.stringify(result.value)}`);
  }
  return result.value;
}

const registry = {
  packageExists: (name) => npmPackageExists({ invocation: npmInvocation, cwd: repoRoot, name }),
  distTags: (name) => npmDistTags({ invocation: npmInvocation, cwd: repoRoot, name }),
};

async function main() {
  const {
    execute, otp, outDir: requestedOut, artifacts: requestedArtifacts, tag: requestedTag, trustedPublishing,
    ciRunId, ciArtifactId, ciArtifactDigest,
  } = parseArguments(process.argv.slice(2));
  if (otp && !execute) throw new Error('--otp is only meaningful with --execute');
  const log = (message) => console.log(`[release-publish] ${message}`);


  // --- Step 1: version consistency + registry candidacy -------------------
  const manifests = readPublicManifests(packagesDir);
  const trainEntries = [...manifests.values()];
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
  const headSha = capture('git', ['rev-parse', 'HEAD']);
  const ciRequest = ciRunId === undefined ? undefined : {
    sourceSha: headSha, runId: Number(ciRunId), artifactId: Number(ciArtifactId), artifactDigest: ciArtifactDigest,
  };
  log(`step 1/8: release train version ${trainVersion} across ${trainEntries.length} public package(s)`);

  // The tag is the release's completion marker: it exists only once the registry
  // has been read back, so an existing tag means there is nothing left to do.
  const tag = `v${trainVersion}`;
  const existingTag = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (existingTag.status === 0) throw new Error(`tag ${tag} already exists at ${existingTag.stdout.trim()}`);

  // A version only partially on the registry is a release interrupted between
  // publishes; the remaining packages are exactly the publish set. A version fully on
  // the registry without its tag is a release interrupted after the last publish; it
  // resumes with the readback and the tag and publishes nothing.
  const registryState = new Map();
  for (const entry of manifests.values()) {
    registryState.set(entry.name, isPublished(entry.name, entry.version));
  }
  assertNoPartialPrereleaseRegistryState([...manifests.values()], registryState, distTag);
  const pendingEntries = [...manifests.values()].filter((entry) => !registryState.get(entry.name));
  const alreadyPublished = [...manifests.values()].filter((entry) => registryState.get(entry.name));
  if (pendingEntries.length === 0) {
    log(`every package of ${trainVersion} is on the registry but ${tag} does not exist: resuming with the readback and tag`);
  } else if (alreadyPublished.length > 0) {
    log(`${trainVersion} is a partially published candidate; already on the registry: ${alreadyPublished.map((entry) => entry.name).join(', ')}`);
  }

  const registryExpectations = readRegistryExpectations(repoRoot, [...manifests.keys()]);
  // The prerelease baseline describes the registry before the first write; a resume
  // that writes nothing has no baseline left to check, and the readback covers it.
  if (pendingEntries.length > 0) {
    assertPrereleaseRegistryBaseline([...manifests.values()], registryExpectations, distTag, registry);
  }

  // --- Step 2: build -------------------------------------------------------
  const bunBin = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const frozen = ciRequest !== undefined || requestedArtifacts !== undefined;
  if (frozen) {
    log('step 2/8: build skipped — consuming frozen tarballs');
  } else {
    log('step 2/8: bun run build:release');
    stream(bunBin, ['run', 'build:release']);
  }

  // --- Step 3: frozen artifacts, packed here or downloaded from CI ---------
  const ephemeralRoot = ciRequest || (!frozen && !requestedOut) ? mkdtempSync(path.join(os.tmpdir(), 'byok-release-publish-')) : undefined;
  const outDir = path.resolve(repoRoot, ciRequest ? ephemeralRoot : requestedArtifacts ?? requestedOut ?? path.join(ephemeralRoot, 'artifacts'));
  try {
    if (ciRequest) {
      const verified = fetchReleaseArtifact(ciRequest);
      for (const [name, bytes] of verified.files) writeFileSync(path.join(outDir, name), bytes, { flag: 'wx', mode: 0o600 });
      log(`step 3/8: verified CI run ${ciRequest.runId}, artifact ${ciRequest.artifactId} (${ciRequest.artifactDigest})`);
      if (process.env.GITHUB_ACTIONS === 'true') {
        const evidence = { ...verified.evidence, releaseWorkflowSha: process.env.GITHUB_SHA,
          provenance: 'npm provenance identifies the protected release workflow; this evidence records the original CI build' };
        writeFileSync(path.join(process.env.RUNNER_TEMP, 'release-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          `## Accepted CI release artifact\n\nSource: ${headSha}\n\nCI: https://github.com/Ancienttwo/byok-sdk/actions/runs/${ciRequest.runId}\n\nArtifact: ${ciRequest.artifactId} (${ciRequest.artifactDigest})\n\n${evidence.provenance}\n`);
      }
    } else if (frozen) {
      log(`step 3/8: pack skipped — verifying frozen artifacts in ${outDir}`);
    } else {
      log(`step 3/8: pack-and-smoke into ${outDir}`);
      stream(nodeBin, ['scripts/release/pack-and-smoke.mjs', '--out-dir', outDir]);
    }

    const releaseManifestPath = path.join(outDir, 'release-manifest.json');
    const publishSet = topologicalOrder(pendingEntries);
    // Validate all accepted packages, including already-published resume entries.
    if (ciRequest) {
      const manifest = JSON.parse(readFileSync(releaseManifestPath, 'utf8'));
      if (manifest.packages.length !== manifests.size) throw new Error('Accepted CI artifact package set differs from the release train');
    }
    const verifiedEntries = verifyFrozenArtifacts({ artifactsDir: outDir, headSha, trainVersion,
      publishSet: ciRequest ? [...manifests.values()] : publishSet });
    const verifiedByName = new Map(verifiedEntries.map(entry => [entry.name, entry]));
    const plan = publishSet.map(entry => verifiedByName.get(entry.name));
    const frozenManifest = JSON.parse(readFileSync(releaseManifestPath, 'utf8'));
    assertFrozenRegistryExpectations(frozenManifest, registryExpectations,
      Object.fromEntries([...manifests.values()].map((entry) => [entry.name, entry.version])));
    await assertPublishedMatchFrozen({
      entries: alreadyPublished,
      frozenManifest,
      sleep,
      readIntegrity: (entry) => publishedIntegrity(entry.name, entry.version),
    });
    log(`frozen artifacts verified against ${headSha}; ${alreadyPublished.length} already-published package(s) hold the frozen bytes`);

    // --- Step 4: the full release plan ---------------------------------------
    // Provenance attestations are signed from the GitHub OIDC token, so the flag is
    // only meaningful inside GitHub Actions; a local release says so instead.
    const attestProvenance = process.env.GITHUB_ACTIONS === 'true';
    log(`step 4/8: release plan for ${tag}:`);
    for (const line of describeReleasePlan({
      entries: [...manifests.values()], plan, registryState, tag, distTag, trustedPublishing, provenance: attestProvenance,
    })) {
      log(line);
    }

    if (!execute) {
      log('dry run: steps 5-8 (registry auth gate, npm publish, registry readback, git tag) skipped; rerun with --execute to release');
      return;
    }

    // --- Step 5: registry auth gate -------------------------------------------
    // Everything that can refuse the release runs before the first irreversible
    // action, so a refusal never leaves a half-released train behind.
    if (plan.length === 0) {
      log('step 5/8: registry auth gate skipped — this run writes nothing to the registry');
    } else if (trustedPublishing) {
      log('step 5/8: registry auth gate (trusted publishing)');
      assertTrustedPublishingEnvironment({
        env: process.env,
        npmVersion: capture(npmInvocation.command, [...npmInvocation.prefix, '--version']),
      });
      log('GitHub-hosted OIDC publishing: no long-lived npm token is present');
    } else {
      log('step 5/8: registry account gate');
      const whoami = capture(npmInvocation.command, [...npmInvocation.prefix, 'whoami']);
      const profileOutput = capture(npmInvocation.command, [...npmInvocation.prefix, 'profile', 'get', '--json']);
      let profile;
      try {
        profile = JSON.parse(profileOutput);
      } catch {
        throw new Error(`npm profile get --json returned unreadable output:\n${profileOutput}`);
      }
      assertRegistryAccountPolicy({ whoami, profile });
      log(`npm account ${whoami} requires a second factor on writes`);
    }

    // Recheck after build/pack/account checks, immediately before irreversible writes.
    // Any exact RC publication during preparation invalidates this plan.
    if (plan.length > 0) {
      assertPrereleaseReadyToPublish([...manifests.values()], registryExpectations, distTag, { ...registry, isPublished });
    }

    // --- Step 6: publish -----------------------------------------------------
    log(`step 6/8: npm publish ${plan.length} tarball(s)`);
    await publishPlan({
      plan,
      log,
      prerelease: Boolean(distTag),
      sleep,
      readIntegrity: (entry) => publishedIntegrity(entry.name, entry.version),
      publishTarball: (entry) => stream(npmInvocation.command, [
        ...npmInvocation.prefix,
        'publish',
        path.join(outDir, entry.file),
        '--access',
        'public',
        ...(attestProvenance ? ['--provenance'] : []),
        ...(distTag ? ['--tag', distTag] : []),
        ...(otp ? ['--otp', otp] : []),
      ]),
    });

    // --- Step 7: registry readback ------------------------------------------
    log('step 7/8: registry readback');
    await waitForRegistryVisibility({ entries: [...manifests.values()], isPublished, sleep, log });
    await readbackWithRetry({
      sleep,
      log,
      readback: () => stream(nodeBin, [
        'scripts/release/registry-readback.mjs',
        '--manifest',
        releaseManifestPath,
        ...(distTag ? ['--tag', distTag] : []),
      ]),
    });

    // --- Step 8: annotated tag ----------------------------------------------
    // Last, and only once the registry itself confirms the train: a tag created any
    // earlier can outlive a failed publish and name a release that does not exist.
    log(`step 8/8: git tag -a ${tag}`);
    capture('git', ['tag', '-a', tag, '-m', `${tag}\n\nsourceGitSha ${headSha}`]);
    log(`OK: ${plan.length} package(s) published, ${manifests.size} read back and tagged ${tag}`);
  } finally {
    if (ephemeralRoot) rmSync(ephemeralRoot, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
