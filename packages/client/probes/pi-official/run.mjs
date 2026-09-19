#!/usr/bin/env node
/**
 * OP1 probe orchestrator.
 *
 * Creates a throwaway install of the real official npm release, copies the probe
 * sources next to it so their imports resolve to THAT release, runs every probe
 * in its own process with an empty HOME, and writes the collected evidence.
 *
 * Usage: node packages/client/probes/pi-official/run.mjs [--official-version 0.85.1] [--probe p01]
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const officialVersion = argValue('--official-version') ?? '0.85.1';
const only = argValue('--probe');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const probeRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-official-probe-'));
const evidenceRoot = path.join(
  repoRoot,
  '.ai',
  'harness',
  'runs',
  `pi-official-op1-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
mkdirSync(evidenceRoot, { recursive: true });

console.log(`[op1] isolated install root: ${probeRoot}`);
console.log(`[op1] evidence dir:          ${evidenceRoot}`);

writeFileSync(
  path.join(probeRoot, 'package.json'),
  `${JSON.stringify({ name: 'pi-official-op1-probes', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`,
);

const install = await run('npm', [
  'install',
  '--no-audit',
  '--no-fund',
  '--ignore-scripts',
  '--prefix',
  probeRoot,
  `@earendil-works/pi-coding-agent@${officialVersion}`,
  `@earendil-works/pi-ai@${officialVersion}`,
  'typebox@1.3.7',
]);
if (install.code !== 0) {
  console.error(install.stderr || install.stdout);
  process.exit(install.code ?? 1);
}

const installedManifest = JSON.parse(
  readFileSync(path.join(probeRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'),
);
// The published package ships its own shrinkwrap, so the top-level package-lock
// entry can omit integrity. The hidden install lock records what is actually on
// disk, which is the identity that matters here.
const hiddenLockPath = path.join(probeRoot, 'node_modules', '.package-lock.json');
const lock = JSON.parse(
  readFileSync(
    existsSync(hiddenLockPath) ? hiddenLockPath : path.join(probeRoot, 'package-lock.json'),
    'utf8',
  ),
);
/** `--prefix` makes npm key the lock by a relative path, so match on the suffix. */
function lockEntryFor(packageName) {
  const matches = Object.entries(lock.packages ?? {})
    .filter(([key]) => key.endsWith(`node_modules/${packageName}`))
    .sort((left, right) => left[0].length - right[0].length);
  return matches[0]?.[1];
}
const installedEntry = lockEntryFor('@earendil-works/pi-coding-agent');
const installedAiEntry = lockEntryFor('@earendil-works/pi-ai');

cpSync(path.join(here, 'lib'), path.join(probeRoot, 'probes', 'lib'), { recursive: true });
cpSync(path.join(here, 'probes'), path.join(probeRoot, 'probes', 'probes'), { recursive: true });

const probeFiles = readdirSync(path.join(here, 'probes'))
  .filter((name) => name.endsWith('.mjs'))
  .filter((name) => (only ? name.startsWith(only) : true))
  .sort();

const emptyHome = path.join(probeRoot, 'empty-home');
mkdirSync(emptyHome, { recursive: true });

const results = [];
for (const file of probeFiles) {
  const probeName = file.replace(/\.mjs$/, '');
  console.log(`[op1] running ${probeName}`);
  const execution = await run(
    process.execPath,
    [path.join(probeRoot, 'probes', 'probes', file)],
    {
      cwd: emptyHome,
      env: {
        PATH: process.env.PATH,
        HOME: emptyHome,
        PI_PROBE_EVIDENCE_DIR: evidenceRoot,
        PI_PROBE_INSTALL_ROOT: probeRoot,
        PI_PROBE_OFFICIAL_VERSION: `${installedManifest.name}@${installedManifest.version}`,
      },
    },
  );
  writeFileSync(path.join(evidenceRoot, `${probeName}.log`), `# exit=${execution.code}\n\n## stdout\n${execution.stdout}\n## stderr\n${execution.stderr}\n`);
  const line = execution.stdout.split('\n').find((entry) => entry.startsWith('PROBE_RESULT '));
  let parsed;
  if (line) {
    try {
      parsed = JSON.parse(line.slice('PROBE_RESULT '.length));
    } catch (error) {
      parsed = { probe: probeName, ok: false, error: `unparseable result: ${String(error)}` };
    }
  } else {
    parsed = { probe: probeName, ok: false, error: `no PROBE_RESULT line (exit=${execution.code})`, stderr: execution.stderr.slice(0, 2000) };
  }
  parsed.exitCode = execution.code;
  results.push(parsed);
}

const summary = {
  kind: 'official-pi-op1-probe-summary',
  generatedAt: new Date().toISOString(),
  officialPackage: `${installedManifest.name}@${installedManifest.version}`,
  officialIntegrity: installedEntry?.integrity ?? null,
  officialPiAiIntegrity: installedAiEntry?.integrity ?? null,
  officialResolved: installedEntry?.resolved ?? null,
  // The published tarball manifest carries no gitHead; the authoritative build
  // commit for this exact version is recorded in the OP0 baseline instead.
  officialGitHead: installedManifest.gitHead ?? null,
  isolation: { probeRoot, emptyHome, node: process.version, platform: `${process.platform}-${process.arch}` },
  probes: results,
  ok: results.every((entry) => entry.ok === true),
  completed: results.every((entry) => typeof entry.verdict === 'string'),
  verdicts: Object.fromEntries(results.map((entry) => [entry.probe, entry.verdict ?? 'none'])),
};
writeFileSync(path.join(evidenceRoot, 'probe-results.json'), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`[op1] summary: completed=${summary.completed} verdicts=${JSON.stringify(summary.verdicts)}`);
for (const result of results) {
  console.log(`  - ${result.probe}: ${result.verdict ?? 'no-verdict'}${result.error ? ` (${result.error})` : ''}`);
}
rmSync(probeRoot, { recursive: true, force: true });
process.exit(summary.completed ? 0 : 1);
