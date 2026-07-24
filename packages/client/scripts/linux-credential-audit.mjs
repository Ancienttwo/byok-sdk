#!/usr/bin/env node
// Linux-only strace audit for the exact adapter-task smoke. It first validates
// tracing with a positive control that opens all synthetic canaries, then traces
// the normal smoke and rejects any exact canonical-canary open.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  canonicalCanaryPaths,
  normalizeTraceEvidence,
  normalSmokeVerdict,
  positiveControlVerdict,
} from './credential-audit-core.mjs';

if (process.platform !== 'linux') {
  console.error(`UNSUPPORTED: credential audit requires Linux strace; current platform is ${process.platform}`);
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const smokeScript = path.join(scriptDir, 'adapter-task-smoke.mjs');
const positiveControlScript = path.join(scriptDir, 'credential-audit-positive-control.mjs');
const straceArgs = ['-ff', '-s', '4096', '-e', 'trace=open,openat,read,process'];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr, pid: child.pid }));
  });
}

async function readTraceFiles(directory) {
  const names = (await fs.readdir(directory))
    .filter((name) => name.startsWith('trace.'))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      text: await fs.readFile(path.join(directory, name), 'utf8'),
    })),
  );
}

async function ensureCanaries(home) {
  const canonicalPaths = canonicalCanaryPaths(home);
  for (const [runtime, file] of Object.entries(canonicalPaths)) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `synthetic-${runtime}-canary\n`, { mode: 0o600 });
  }
  return canonicalPaths;
}

function parsePositiveOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed.opened) && JSON.stringify([...parsed.opened].sort()) === JSON.stringify(['claude', 'codex', 'pi']);
  } catch {
    return false;
  }
}

function processEvidenceRoles(evidence) {
  return [...new Set(evidence.processes.flatMap((process) => process.roles))].sort();
}

const configuredTraceDir = argValue('--trace-dir') ?? process.env.BYOK_CREDENTIAL_AUDIT_TRACE_DIR;
const configuredSummary = argValue('--summary') ?? process.env.BYOK_CREDENTIAL_AUDIT_SUMMARY;
const traceDir = path.resolve(configuredTraceDir ?? path.join(os.tmpdir(), `byok-credential-audit-${process.pid}`));
const summaryPath = path.resolve(configuredSummary ?? path.join(traceDir, 'summary.json'));
const positiveDir = path.join(traceDir, 'positive');
const smokeDir = path.join(traceDir, 'smoke');
const fakeHome = path.join(traceDir, 'home');
const baseEnvironment = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: fakeHome,
  TMPDIR: path.join(traceDir, 'tmp'),
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  SHELL: '/bin/sh',
};

let failed = false;
let failure;
let canonicalPaths;
let positiveRun;
let smokeRun;
let positiveEvidence;
let smokeEvidence;
let positiveVerdict;
let smokeVerdict;

try {
  await fs.rm(traceDir, { recursive: true, force: true });
  await fs.mkdir(baseEnvironment.TMPDIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(positiveDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(smokeDir, { recursive: true, mode: 0o700 });
  canonicalPaths = await ensureCanaries(fakeHome);

  let straceVersion;
  try {
    const version = await runProcess('strace', ['-V'], baseEnvironment);
    if (version.code !== 0) throw new Error(version.stderr || `exit code ${version.code}`);
    straceVersion = version.stdout.split(/\r?\n/, 1)[0].trim();
  } catch (error) {
    throw new Error(`strace is required but unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  positiveRun = await runProcess(
    'strace',
    [...straceArgs, '-o', path.join(positiveDir, 'trace'), process.execPath, positiveControlScript, '--home', fakeHome],
    baseEnvironment,
  );
  const positiveTraceFiles = await readTraceFiles(positiveDir);
  positiveEvidence = normalizeTraceEvidence(positiveTraceFiles, canonicalPaths);
  positiveVerdict = positiveControlVerdict(positiveEvidence, canonicalPaths);
  const positiveOutputValid = parsePositiveOutput(positiveRun.stdout);
  if (positiveRun.code !== 0 || !positiveOutputValid || !positiveVerdict.pass) {
    const attribution = positiveVerdict?.unresolvedProcesses?.length
      ? `; attribution failure: unresolved traced processes ${JSON.stringify(positiveVerdict.unresolvedProcesses)}`
      : '';
    throw new Error(
      `positive control invalid (exit=${positiveRun.code}, outputValid=${positiveOutputValid}, verdict=${JSON.stringify(positiveVerdict)})${attribution}`,
    );
  }
  console.log(`PASS: positive control captured all canonical canaries with ${straceVersion}`);

  smokeRun = await runProcess(
    'strace',
    [...straceArgs, '-o', path.join(smokeDir, 'trace'), process.execPath, smokeScript],
    { ...baseEnvironment, BYOK_SMOKE_HOME: fakeHome },
  );
  if (smokeRun.stdout) process.stdout.write(smokeRun.stdout);
  if (smokeRun.stderr) process.stderr.write(smokeRun.stderr);
  const smokeTraceFiles = await readTraceFiles(smokeDir);
  smokeEvidence = normalizeTraceEvidence(smokeTraceFiles, canonicalPaths);
  smokeVerdict = normalSmokeVerdict(smokeEvidence);
  if (smokeRun.code !== 0) throw new Error(`adapter smoke failed under strace (exit=${smokeRun.code}, signal=${smokeRun.signal ?? 'none'})`);
  if (!smokeVerdict.pass) {
    if (smokeVerdict.unresolvedProcesses.length > 0) {
      throw new Error(`attribution failure: unresolved traced processes ${JSON.stringify(smokeVerdict.unresolvedProcesses)}`);
    }
    throw new Error(`canonical credential canary access detected: ${JSON.stringify(smokeVerdict.canonicalOpens)}`);
  }
  console.log('PASS: normal adapter smoke had zero canonical-canary opens');
} catch (error) {
  failed = true;
  failure = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${failure}`);
} finally {
  const summary = {
    schemaVersion: 1,
    platform: process.platform,
    traceDir,
    canonicalPaths: canonicalPaths ?? null,
    positiveControl: {
      run: positiveRun
        ? { code: positiveRun.code, signal: positiveRun.signal, pid: positiveRun.pid, outputValid: parsePositiveOutput(positiveRun.stdout) }
        : null,
      verdict: positiveVerdict ?? null,
      evidence: positiveEvidence
        ? { ...positiveEvidence, observedRoles: processEvidenceRoles(positiveEvidence) }
        : null,
    },
    smoke: {
      run: smokeRun ? { code: smokeRun.code, signal: smokeRun.signal, pid: smokeRun.pid } : null,
      verdict: smokeVerdict ?? null,
      evidence: smokeEvidence
        ? { ...smokeEvidence, observedRoles: processEvidenceRoles(smokeEvidence) }
        : null,
    },
    verdict: failed ? 'FAIL' : 'PASS',
    failure: failure ?? null,
  };
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8').catch((error) => {
    failed = true;
    console.error(`FAIL: could not write audit summary ${summaryPath}: ${error instanceof Error ? error.message : String(error)}`);
  });
  console.log(`credential audit raw traces: ${traceDir}`);
  console.log(`credential audit summary: ${summaryPath}`);
}

process.exit(failed ? 1 : 0);
