import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeAclProbeObserver, type OwnedAclProbe } from './fixtures/owned-acl-probe';
import {
  PI_ACL_CLIENT_STARTUP_DEADLINE_MS,
  PI_ACL_COLD_EVIDENCE_BUDGET_MS,
  PI_ACL_ICACLS_DEADLINE_MS,
  PI_ACL_TEARDOWN_EVIDENCE_BUDGET_MS,
  PI_ACL_WARM_EVIDENCE_BUDGET_MS,
  remainingAclEvidenceMs,
} from './fixtures/acl-evidence-budget';
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

// Phased timing instrumentation for the positive cases only: a cold first ACL
// query can sit close to its evidence budget, and the log must attribute the
// time (fixture icacls spawn vs the fixed-system Windows PowerShell probe vs
// assertion). Every phase prints one `[pi-acl-positive]` line, and each
// test-owned icacls child gets a hard sub-deadline: on expiry the child is
// killed and the phase reports elapsed time plus whatever output it produced,
// so the next CI run can distinguish environment latency from probe failure.
// None of this changes an assertion or the approval standard. The budgets live
// in ./fixtures/acl-evidence-budget so a cross-platform regression can assert
// the cold watchdog stays inside the client deadline and the others stay
// inside Vitest's default test/hook timeouts.
const PHASE_LOG_PREFIX = '[pi-acl-positive]';

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
    await pending.owner.dispose(PI_ACL_TEARDOWN_EVIDENCE_BUDGET_MS, async () => {
      const started = Date.now();
      await fs.rm(pending.directory, { recursive: true, force: true });
      pending.log('cleanup', `elapsed=${Date.now() - started}ms (owned child closed before fs.rm)`);
    });
    pendingCleanup = undefined;
    nativeAclProbeObserver.assertIdle();
  });
  // The owned positive case. `label` names its log prefix; `evidenceBudgetMs`
  // is the whole-case evidence budget the watchdog enforces inside the test's
  // own timeout. Ownership, cancellation and disposal are identical for both uses.
  async function runOwnedPositiveCase({ label, evidenceBudgetMs }: { label: string; evidenceBudgetMs: number }): Promise<void> {
    const logPrefix = `${PHASE_LOG_PREFIX.slice(0, -1)}-${label}]`;
    const testStart = Date.now();
    const logPhase = (phase: string, message: string): void => {
      console.log(`${logPrefix} phase=${phase} t+${Date.now() - testStart}ms ${message}`);
    };

    const tmpdirStarted = Date.now();
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-positive-')));
    logPhase('tmpdir', `elapsed=${Date.now() - tmpdirStarted}ms (mkdtemp+realpath)`);
    let owner: OwnedAclProbe | undefined;
    try {
      // Phase: process spawn -- the fixture's own icacls child.
      const fixture = await execFileBounded('icacls', privateFixtureArgs(directory), PI_ACL_ICACLS_DEADLINE_MS);
      logPhase('process-spawn', `icacls fixture ${describeBoundedResult(fixture)}`);
      if (fixture.timedOut) {
        throw new Error(`${logPrefix} fixture icacls exceeded its ${PI_ACL_ICACLS_DEADLINE_MS}ms sub-deadline and was killed; no ACL was ever asserted`);
      }
      if (fixture.exitCode !== 0) {
        throw new Error(`${logPrefix} fixture icacls failed (exit ${fixture.exitCode}): ${fixture.stderr}`);
      }

      // Phase: icacls read-back -- diagnostic only. It prints the ACL the
      // probe is about to judge, so a probe failure in the next phase can be
      // attributed to the fixture state vs the probe itself. Its own timeout
      // never changes the verdict.
      const readBack = await execFileBounded('icacls', [directory], PI_ACL_ICACLS_DEADLINE_MS);
      if (readBack.timedOut) {
        logPhase('icacls-readback', `DIAGNOSTIC ONLY, timed out and was killed: ${describeBoundedResult(readBack)}`);
      } else {
        logPhase('icacls-readback', `elapsed=${readBack.elapsedMs}ms exitCode=${readBack.exitCode}`);
        console.log(`${logPrefix} icacls read-back of the fixture:\n${readBack.stdout}`);
      }

      // Phase: ACL probe + assertion -- the powershell Get-Acl child inside
      // assertWindowsPiProjectionAcl, then the full approval checks. The
      // watchdog fires just inside the test's own timeout so a hung probe
      // fails with the phase log above instead of a bare vitest timeout. The
      // probe is invocation-owned. Expiry cancels the captured child (or
      // suppresses a late native start); afterEach awaits its disposal receipt.
      const probeBudgetMs = remainingAclEvidenceMs(evidenceBudgetMs, Date.now() - testStart);
      const probeStarted = Date.now();
      owner = nativeAclProbeObserver.create({
        executable: path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        stdin: JSON.stringify({ path: directory }),
      }, event => logPhase(`owned-${event.phase}`, `generation=${event.generation} t=${event.elapsedMs}ms pid=${event.pid ?? 'none'} ${event.detail ?? ''}`));
      pendingCleanup = { directory, owner, log: logPhase };
      const probe = owner.run(() => assertPiProjectionDirectory(directory));
      let watchdog: NodeJS.Timeout | undefined;
      const watchdogPromise = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          const failure = new Error(
            `${logPrefix} phase=acl-probe+assertion exceeded its ${probeBudgetMs}ms evidence budget `
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
  }

  // Cold first use: the account's first Windows PowerShell 5.1 start, which the
  // product pays inside the client's startup deadline. CI runs no prepay before
  // this suite, so this case must be the process's first ACL query; the counter
  // checks that precondition instead of trusting declaration order.
  //
  // Nightly run 41143045892 failed the bound: the first probe produced no
  // output for 29,741ms and the next was still over 4.7s. The three later
  // cases then passed in 2,309ms, 322ms and 397ms (test durations, including
  // their fixture setup) once the interpreter was warm; no ACL assertion
  // failed. The monotonic warm-up points at the hosted runner's fresh-account
  // first-use cost (Defender/disk), not an ACL-policy regression. The bound is
  // deliberately unchanged here: a rerun must show whether that cost
  // reproduces before the cold budget or the product deadline is revisited.
  it('accepts a private empty directory on the account\'s first Windows PowerShell use (cold, client startup deadline)', async () => {
    expect(nativeAclProbeObserver.matchingInvocations, 'the cold first-use case must be the first ACL query').toBe(0);
    await runOwnedPositiveCase({ label: 'cold', evidenceBudgetMs: PI_ACL_COLD_EVIDENCE_BUDGET_MS });
  }, PI_ACL_CLIENT_STARTUP_DEADLINE_MS);
  // Warm steady state: a fresh directory, after the first ACL query was paid
  // above, under the original 4.8s evidence budget and the default 5s test
  // timeout.
  it('accepts a private empty directory with the approved ACL', async () => {
    expect(nativeAclProbeObserver.matchingInvocations, 'the cold first-use case must run first').toBeGreaterThanOrEqual(1);
    await runOwnedPositiveCase({ label: 'warm', evidenceBudgetMs: PI_ACL_WARM_EVIDENCE_BUDGET_MS });
  });
  it('refuses a real external Allow ACE', async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-foreign-')));
    try {
      await createPrivateFixture(directory);
      await exec('icacls', [directory, '/grant', '*S-1-1-0:(R)', '/Q'], { windowsHide: true });
      await expect(assertPiProjectionDirectory(directory)).rejects.toThrow('pi_projection_acl_unauthorized_ace');
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
      await expect(assertPiProjectionDirectory(junction)).rejects.toThrow('pi_projection_not_directory_or_symlink');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  // The request travels on stdin as UTF-8; a console code page must not
  // turn a non-ASCII profile or temp path into a missing one.
  it('accepts a private directory under a non-ASCII path', async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl 空間 ü-')));
    try {
      await createPrivateFixture(directory);
      await expect(assertPiProjectionDirectory(directory)).resolves.toBeUndefined();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  // A PowerShell 7 session exports a PSModulePath whose first entries hold its
  // own Microsoft.PowerShell.Security; Windows PowerShell 5.1 cannot load it.
  // This fixture shadows the module the same way, deterministically.
  it('is not steered by an inherited PSModulePath that shadows Microsoft.PowerShell.Security', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-modpath-')));
    const directory = path.join(root, 'projection');
    const shadow = path.join(root, 'modules', 'Microsoft.PowerShell.Security');
    const inherited = process.env.PSModulePath;
    try {
      await createPrivateFixture(directory);
      await fs.mkdir(shadow, { recursive: true });
      await fs.writeFile(path.join(shadow, 'Microsoft.PowerShell.Security.psm1'), "throw 'shadowed Microsoft.PowerShell.Security'\n");
      await fs.writeFile(path.join(shadow, 'Microsoft.PowerShell.Security.psd1'),
        "@{ ModuleVersion = '99.0.0'; RootModule = 'Microsoft.PowerShell.Security.psm1'; FunctionsToExport = @('Get-Acl', 'Set-Acl'); CmdletsToExport = @() }\n");
      process.env.PSModulePath = [path.join(root, 'modules'), inherited].filter(Boolean).join(';');
      await expect(assertPiProjectionDirectory(directory)).resolves.toBeUndefined();
    } finally {
      if (inherited === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = inherited;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('reports a missing directory with a closed cause and no path', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-missing-')));
    try {
      const failure = await assertWindowsPiProjectionAcl(path.join(root, 'absent')).then(() => undefined, (error: unknown) => error);
      expect((failure as Error).message).toBe('pi_projection_acl_query_failed: Pi projection ACL query failed (cause=path_not_found, exit=3)');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
