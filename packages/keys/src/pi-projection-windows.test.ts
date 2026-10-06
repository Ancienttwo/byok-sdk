import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeAclProbeObserver, type OwnedAclProbe } from './fixtures/owned-acl-probe';
import { assertPiProjectionDirectory, assertWindowsPiProjectionAcl } from './pi-provider-launcher-core';

// These wrappers only observe one matching test-owned invocation. The original
// runner/spawn are still called and return their original promise/child/result.
vi.mock('./command-runner', async importOriginal => {
  const actual = await importOriginal<typeof import('./command-runner')>();
  const { nativeAclProbeObserver: observer } = await import('./fixtures/owned-acl-probe');
  return { ...actual, runCommand: function (this: unknown, ...args: Parameters<typeof actual.runCommand>) {
    return observer.command(actual.runCommand, this, args);
  } };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { nativeAclProbeObserver: observer } = await import('./fixtures/owned-acl-probe');
  return { ...actual, spawn: function (this: unknown, ...args: Parameters<typeof actual.spawn>) {
    return observer.spawn(actual.spawn, this, args);
  } };
});
afterAll(() => {
  vi.doUnmock('./command-runner');
  vi.doUnmock('node:child_process');
});

const exec = promisify(execFile);
// Test-owned physical ACL fixture; no cross-package internal import. This tests
// keys validation, not the client's allocator implementation. The args live in
// one place so the instrumented positive case below runs the exact fixture the
// other cases run.
function privateFixtureArgs(directory: string): string[] {
  return [directory, '/inheritance:r', '/grant:r',
    `${os.userInfo().username}:(OI)(CI)F`, '/grant', '*S-1-5-18:(OI)(CI)F',
    '/grant', '*S-1-5-32-544:(OI)(CI)F'];
}
async function createPrivateFixture(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await exec('icacls', privateFixtureArgs(directory), { windowsHide: true });
}

// Phased timing instrumentation for the positive case only: on windows-latest
// this test has run at ~5s against vitest's default 5000ms testTimeout and the
// log could not attribute the time (fixture icacls spawn vs powershell Get-Acl
// probe vs assertion). Every phase prints one `[pi-acl-positive]` line, and
// each test-owned icacls child gets a hard sub-deadline: on expiry the child
// is killed and the phase reports elapsed time plus whatever output it
// produced, so the next CI run can distinguish environment latency from probe
// failure. None of this changes an assertion, the approval standard, or the
// 5000ms budget; phase observation now also retains failed-test disposal ownership.
const PHASE_LOG_PREFIX = '[pi-acl-positive]';
const ICACLS_DEADLINE_MS = 2_000;
const TEST_EVIDENCE_BUDGET_MS = 4_800;
// Report unresolved disposal inside Vitest's unchanged 10s default hook budget.
// This does not extend either the existing 4.8s evidence or 5s test budget.
const TEARDOWN_EVIDENCE_BUDGET_MS = 9_800;

interface BoundedExecResult {
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
  exitCode: number | string | null;
  signal: NodeJS.Signals | null;
}

function execFileBounded(file: string, args: string[], deadlineMs: number): Promise<BoundedExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let deadline: NodeJS.Timeout | undefined;
    const child = execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (deadline !== undefined) clearTimeout(deadline);
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        elapsedMs: Date.now() - startedAt,
        timedOut,
        exitCode: error === null ? 0 : error.code ?? null,
        signal: error === null ? null : error.signal ?? null,
      });
    });
    deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, deadlineMs);
  });
}

function describeBoundedResult(result: BoundedExecResult): string {
  const detail = `elapsed=${result.elapsedMs}ms exitCode=${result.exitCode ?? 'none'}`;
  if (!result.timedOut) return detail;
  const reclaimed = result.signal !== null
    ? `reclaimed via kill (signal=${result.signal}, process exited and was reaped)`
    : 'kill sent';
  return `${detail} DEADLINE_EXCEEDED ${reclaimed}; partial stdout=${result.stdout.length}B stderr=${JSON.stringify(result.stderr)}`;
}

// Runs in the existing real non-administrator release-pack lane. POSIX cannot
// provide ACL/token evidence and explicitly skips this platform-only suite.
describe.skipIf(process.platform !== 'win32')('real Windows keys projection ACL', () => {
  let pendingCleanup: { directory: string; owner: OwnedAclProbe; log: (phase: string, message: string) => void } | undefined;
  beforeEach(() => nativeAclProbeObserver.assertIdle());
  afterEach(async () => {
    const pending = pendingCleanup;
    if (!pending) return;
    await pending.owner.dispose(TEARDOWN_EVIDENCE_BUDGET_MS, async () => {
      const started = Date.now();
      await fs.rm(pending.directory, { recursive: true, force: true });
      pending.log('cleanup', `elapsed=${Date.now() - started}ms (owned child closed before fs.rm)`);
    });
    pendingCleanup = undefined;
    nativeAclProbeObserver.assertIdle();
  });
  it('accepts a private empty directory with the approved ACL', async () => {
    const testStart = Date.now();
    const logPhase = (phase: string, message: string): void => {
      console.log(`${PHASE_LOG_PREFIX} phase=${phase} t+${Date.now() - testStart}ms ${message}`);
    };

    const tmpdirStarted = Date.now();
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-positive-')));
    logPhase('tmpdir', `elapsed=${Date.now() - tmpdirStarted}ms (mkdtemp+realpath)`);
    let owner: OwnedAclProbe | undefined;
    try {
      // Phase: process spawn -- the fixture's own icacls child.
      const fixture = await execFileBounded('icacls', privateFixtureArgs(directory), ICACLS_DEADLINE_MS);
      logPhase('process-spawn', `icacls fixture ${describeBoundedResult(fixture)}`);
      if (fixture.timedOut) {
        throw new Error(`${PHASE_LOG_PREFIX} fixture icacls exceeded its ${ICACLS_DEADLINE_MS}ms sub-deadline and was killed; no ACL was ever asserted`);
      }
      if (fixture.exitCode !== 0) {
        throw new Error(`${PHASE_LOG_PREFIX} fixture icacls failed (exit ${fixture.exitCode}): ${fixture.stderr}`);
      }

      // Phase: icacls read-back -- diagnostic only. It prints the ACL the
      // probe is about to judge, so a probe failure in the next phase can be
      // attributed to the fixture state vs the probe itself. Its own timeout
      // never changes the verdict.
      const readBack = await execFileBounded('icacls', [directory], ICACLS_DEADLINE_MS);
      if (readBack.timedOut) {
        logPhase('icacls-readback', `DIAGNOSTIC ONLY, timed out and was killed: ${describeBoundedResult(readBack)}`);
      } else {
        logPhase('icacls-readback', `elapsed=${readBack.elapsedMs}ms exitCode=${readBack.exitCode}`);
        console.log(`${PHASE_LOG_PREFIX} icacls read-back of the fixture:\n${readBack.stdout}`);
      }

      // Phase: ACL probe + assertion -- the powershell Get-Acl child inside
      // assertWindowsPiProjectionAcl, then the full approval checks. The
      // watchdog fires just inside vitest's 5000ms budget so a hung probe
      // fails with the phase log above instead of a bare vitest timeout. The
      // probe is invocation-owned. Expiry cancels the captured child (or
      // suppresses a late native start); afterEach awaits its disposal receipt.
      const probeBudgetMs = Math.max(TEST_EVIDENCE_BUDGET_MS - (Date.now() - testStart), 0);
      const probeStarted = Date.now();
      owner = nativeAclProbeObserver.create({
        executable: path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        stdin: JSON.stringify({ path: directory }),
      }, event => logPhase(`owned-${event.phase}`, `generation=${event.generation} t=${event.elapsedMs}ms pid=${event.pid ?? 'none'} ${event.detail ?? ''}`));
      pendingCleanup = { directory, owner, log: logPhase };
      const probe = owner.run(() => assertPiProjectionDirectory(directory, directory));
      let watchdog: NodeJS.Timeout | undefined;
      const watchdogPromise = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          const failure = new Error(
            `${PHASE_LOG_PREFIX} phase=acl-probe+assertion exceeded its ${probeBudgetMs}ms evidence budget `
            + `(probe started at t+${probeStarted - testStart}ms); the phases above show where the time went; `
            + 'this is instrumentation, the approval checks themselves are unchanged',
          );
          owner!.cancel(failure);
          reject(failure);
        }, probeBudgetMs);
      });
      try {
        await expect(Promise.race([probe, watchdogPromise])).resolves.toBeUndefined();
        logPhase('acl-probe+assertion', `elapsed=${Date.now() - probeStarted}ms (powershell Get-Acl probe + full approval checks)`);
      } finally {
        if (watchdog !== undefined) clearTimeout(watchdog);
      }
    } finally {
      // Once the assertion starts, only owned teardown may delete this fixture.
      if (!owner) {
        const rmStarted = Date.now();
        await fs.rm(directory, { recursive: true, force: true });
        logPhase('cleanup', `elapsed=${Date.now() - rmStarted}ms (fixture setup failed before probe)`);
      }
    }
  });
  it('refuses a real external Allow ACE', async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-foreign-')));
    try {
      await createPrivateFixture(directory);
      await exec('icacls', [directory, '/grant', '*S-1-1-0:(R)', '/Q'], { windowsHide: true });
      await expect(assertPiProjectionDirectory(directory, directory)).rejects.toThrow('pi_projection_acl_unauthorized_ace');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  it('refuses the real Windows directory owner rather than the current token', async () => {
    if (!process.env.SystemRoot) throw new Error('SystemRoot missing');
    await expect(assertWindowsPiProjectionAcl(process.env.SystemRoot)).rejects.toThrow('pi_projection_owner_mismatch');
  });
  it('refuses a real directory junction', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-junction-')));
    const directory = path.join(root, 'target');
    const junction = path.join(root, 'junction');
    try {
      await createPrivateFixture(directory);
      await fs.symlink(directory, junction, 'junction');
      await expect(assertWindowsPiProjectionAcl(junction)).rejects.toThrow('pi_projection_reparse_point');
      await expect(assertPiProjectionDirectory(junction, junction)).rejects.toThrow('pi_projection_not_directory_or_symlink');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
