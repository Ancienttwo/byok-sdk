import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonRecord } from '../index';
import {
  appendAuditRecord,
  AUDIT_LOG_TRIM_TARGET_LINES,
  auditLogPath,
  createAuditAppender,
  formatDaemonRecordLine,
  MAX_AUDIT_LOG_BYTES,
  MAX_LIVE_TASK_ANCHORS,
  readAuditRecords,
  readLastEnvironmentRecord,
  readLastLifecycleRecord,
} from '../bin/audit-log';
import { atomicWriteFile } from '../util/atomic-write';
import { deriveTasksFromRecords } from '../bin/tasks-view';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function lifecycleRecord(connection: 'open' | 'connecting', ts: string): DaemonRecord {
  return { kind: 'lifecycle', ts, lifecycle: { phase: 'running', connection } };
}

describe('bin/audit-log: appendAuditRecord / readAuditRecords', () => {
  it('reads back a retention failure for the agent-result class', async () => {
    const storeDir = await tmpDir('byok-audit-retention-');
    const record: DaemonRecord = { kind: 'retention-failure', ts: '2026-10-14T00:00:00.000Z', trigger: 'periodic', classId: 'agent-result', code: 'sweep_failed', count: 1 };
    await appendAuditRecord(storeDir, record);
    expect(await readAuditRecords(storeDir)).toEqual([record]);
  });

  it('captures queued lines before nested records mutate, and returns the exact stdout bytes', async () => {
    const storeDir = await tmpDir('byok-audit-capture-');
    const appender = createAuditAppender(storeDir);
    const lifecycle = { phase: 'running' as const, connection: 'connecting' as 'connecting' | 'open' };
    const record: DaemonRecord = { kind: 'lifecycle', ts: '2026-10-14T00:00:00.000Z', lifecycle };
    const first = appender.append(record);
    lifecycle.connection = 'open';
    const second = appender.append(record);
    expect(first).not.toBe(second);
    expect(JSON.parse(first).lifecycle.connection).toBe('connecting');
    expect(JSON.parse(second).lifecycle.connection).toBe('open');
    await appender.flush();
    expect(await fs.readFile(auditLogPath(storeDir), 'utf8')).toBe(`${first}\n${second}\n`);
  });

  it('writes exactly formatDaemonRecordLine(record) plus a newline — the bytes start prints to stdout', async () => {
    const storeDir = await tmpDir('byok-audit-line-');
    const record: DaemonRecord = { kind: 'completed', ts: '2026-01-01T00:00:00.000Z', taskId: 't1', sessionRef: 's', summaryBytes: 3 };
    await appendAuditRecord(storeDir, record);
    expect(await fs.readFile(auditLogPath(storeDir), 'utf8')).toBe(`${formatDaemonRecordLine(record)}\n`);
  });

  it('drops lines in another shape: an unknown kind (an older build\'s per-event progress or connection line) or a task record without a taskId', async () => {
    const storeDir = await tmpDir('byok-audit-foreign-');
    const good: DaemonRecord = { kind: 'started', ts: '2026-01-01T00:00:02.000Z', taskId: 't1' };
    const lines = [
      JSON.stringify({ kind: 'progress', ts: '2026-01-01T00:00:00.000Z', taskId: 't1', event: { type: 'progress', textSize: 3 } }),
      JSON.stringify({ kind: 'connection', ts: '2026-01-01T00:00:00.500Z', state: 'open' }),
      JSON.stringify({ kind: 'started', ts: '2026-01-01T00:00:01.000Z' }),
      JSON.stringify(good),
    ];
    await fs.writeFile(auditLogPath(storeDir), `${lines.join('\n')}\n`, { mode: 0o600 });
    expect(await readAuditRecords(storeDir)).toEqual([good]);
  });

  it('readLastLifecycleRecord / readLastEnvironmentRecord return the latest valid one', async () => {
    const storeDir = await tmpDir('byok-audit-last-');
    await appendAuditRecord(storeDir, lifecycleRecord('connecting', '2026-01-01T00:00:00.000Z'));
    await appendAuditRecord(storeDir, { kind: 'environment-resolved', ts: '2026-01-01T00:00:01.000Z', source: 'login-shell', shell: 'zsh', durationMs: 5 });
    await appendAuditRecord(storeDir, lifecycleRecord('open', '2026-01-01T00:00:02.000Z'));
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-01-01T00:00:03.000Z', source: 'login-shell', shell: '/bin/zsh', durationMs: 5 })}\n`);
    expect(await readLastLifecycleRecord(storeDir)).toEqual({ ts: '2026-01-01T00:00:02.000Z', lifecycle: { phase: 'running', connection: 'open' } });
    expect(await readLastEnvironmentRecord(storeDir)).toEqual({ ts: '2026-01-01T00:00:01.000Z', status: { source: 'login-shell', shell: 'zsh', durationMs: 5 } });
  });

  it('round-trips audit-safe runtime disposal evidence', async () => {
    const storeDir = await tmpDir('byok-audit-runtime-disposal-');
    const event: DaemonRecord = {
      kind: 'runtime-disposal-failed',
      ts: '2026-01-01T00:00:00.000Z',
      taskId: 'task-disposal',
      runtimeId: 'codex',
      stage: 'quiescence',
      reasonBytes: 55,
    };
    await appendAuditRecord(storeDir, event);
    expect(await readAuditRecords(storeDir)).toEqual([event]);
  });

  it('round-trips a crashed lifecycle', async () => {
    const storeDir = await tmpDir('byok-audit-crashed-');
    const crashed: DaemonRecord = { kind: 'lifecycle', ts: '2026-10-14T00:00:00.000Z', lifecycle: { phase: 'crashed', at: '2026-10-14T00:00:00.000Z' } };
    await appendAuditRecord(storeDir, crashed);
    expect(await readAuditRecords(storeDir)).toEqual([crashed]);
  });

  it('#394: round-trips a halted lifecycle, and drops pre-lifecycle connection lines and malformed lifecycles', async () => {
    const storeDir = await tmpDir('byok-audit-lifecycle-');
    const halted: DaemonRecord = {
      kind: 'lifecycle',
      ts: '2026-01-01T00:00:02.000Z',
      lifecycle: { phase: 'halted', reason: 'device_revoked', at: '2026-01-01T00:00:02.000Z' },
    };
    const lines = [
      JSON.stringify({ kind: 'connection', ts: '2026-01-01T00:00:00.000Z', state: 'open' }),
      JSON.stringify({ kind: 'lifecycle', ts: '2026-01-01T00:00:01.000Z', lifecycle: { phase: 'halted', reason: 'made_up', at: 'x' } }),
      JSON.stringify({ kind: 'lifecycle', ts: '2026-01-01T00:00:01.500Z', lifecycle: { phase: 'running', connection: 'closed' } }),
    ];
    await fs.writeFile(auditLogPath(storeDir), `${lines.join('\n')}\n`, { mode: 0o600 });
    await appendAuditRecord(storeDir, halted);
    expect(await readAuditRecords(storeDir)).toEqual([halted]);
  });

  it('appends events as one JSON line each, oldest first, and reads them back', async () => {
    const storeDir = await tmpDir('byok-audit-');
    const e1 = lifecycleRecord('open', '2026-01-01T00:00:00.000Z');
    const e2: DaemonRecord = { kind: 'offered', ts: '2026-01-01T00:00:01.000Z', taskId: 't1', runtime: 'pi' };

    await appendAuditRecord(storeDir, e1);
    await appendAuditRecord(storeDir, e2);

    const raw = await fs.readFile(auditLogPath(storeDir), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);

    const events = await readAuditRecords(storeDir);
    expect(events).toEqual([e1, e2]);
  });

  it('persists and replays claimedRuntime while leaving legacy claim lines without it unchanged', async () => {
    const storeDir = await tmpDir('byok-audit-claimed-runtime-');
    const actual: DaemonRecord = {
      kind: 'claimed',
      ts: '2026-01-01T00:00:00.000Z',
      taskId: 't-actual',
      claimedRuntime: 'pi',
    };
    const legacy: DaemonRecord = { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't-legacy' };

    await appendAuditRecord(storeDir, actual);
    await appendAuditRecord(storeDir, legacy);

    const raw = await fs.readFile(auditLogPath(storeDir), 'utf8');
    const lines = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]?.claimedRuntime).toBe('pi');
    expect(lines[1] && 'claimedRuntime' in lines[1]).toBe(false);
    expect(await readAuditRecords(storeDir)).toEqual([actual, legacy]);
  });

  it('returns [] when the log does not exist yet', async () => {
    const storeDir = await tmpDir('byok-audit-missing-');
    expect(await readAuditRecords(storeDir)).toEqual([]);
  });

  it('skips a corrupt/blank line instead of throwing', async () => {
    const storeDir = await tmpDir('byok-audit-corrupt-');
    const good: DaemonRecord = { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' };
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(auditLogPath(storeDir), `${JSON.stringify(good)}\n\nnot json at all\n{"missing":"kind and ts"}\n`);

    const events = await readAuditRecords(storeDir);
    expect(events).toEqual([good]);
  });

  it('drops a torn trailing line with no terminating newline (a write caught mid-flush) rather than misreading it', async () => {
    const storeDir = await tmpDir('byok-audit-torn-');
    const good: DaemonRecord = { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' };
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(auditLogPath(storeDir), `${JSON.stringify(good)}\n{"kind":"paired","ts":"2026-01-01T00:00:0`);

    const events = await readAuditRecords(storeDir);
    expect(events).toEqual([good]);
  });

  // Finding R3: `shutdown-complete`'s `undeliveredOutboxCount` (finding
  // F5(b)) must survive persistence: `undefined` would be indistinguishable
  // from "0 undelivered".
  it('finding R3: shutdown-complete.undeliveredOutboxCount survives a real append + read round trip', async () => {
    const storeDir = await tmpDir('byok-audit-shutdown-complete-');
    const withCount: DaemonRecord = {
      kind: 'shutdown-complete',
      ts: '2026-01-01T00:00:00.000Z',
      reasonBytes: 8,
      undeliveredOutboxCount: 3,
    };
    const zeroCount: DaemonRecord = {
      kind: 'shutdown-complete',
      ts: '2026-01-01T00:00:01.000Z',
      reasonBytes: 6,
      undeliveredOutboxCount: 0,
    };

    await appendAuditRecord(storeDir, withCount);
    await appendAuditRecord(storeDir, zeroCount);

    const events = await readAuditRecords(storeDir);
    expect(events).toEqual([withCount, zeroCount]);

    // Explicit, not incidental: the persisted line itself carries the field.
    const raw = await fs.readFile(auditLogPath(storeDir), 'utf8');
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]?.undeliveredOutboxCount).toBe(3);
    expect(lines[1]?.undeliveredOutboxCount).toBe(0);
  });

  it('finding R3: a shutdown-complete record without undeliveredOutboxCount reads back as undefined, never a false 0', async () => {
    const storeDir = await tmpDir('byok-audit-shutdown-complete-legacy-');
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'shutdown-complete', ts: '2026-01-01T00:00:00.000Z', reasonBytes: 8 })}\n`);

    const events = await readAuditRecords(storeDir);
    expect(events).toHaveLength(1);
    const [event] = events;
    if (event?.kind !== 'shutdown-complete') throw new Error('unreachable');
    expect(event.undeliveredOutboxCount).toBeUndefined();
  });
});

describe('bin/audit-log: 0600 file, 0700 storeDir', () => {
  it('a pre-existing storeDir with a permissive mode gets locked down to 0700 on append', async () => {
    const parent = await tmpDir('byok-audit-storedir-mode-parent-');
    const storeDir = path.join(parent, 'permissive-store');
    await fs.mkdir(storeDir, { mode: 0o755 });
    const before = await fs.stat(storeDir);
    expect(before.mode & 0o777).toBe(0o755);

    await appendAuditRecord(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' });

    const after = await fs.stat(storeDir);
    expect(after.mode & 0o777).toBe(0o700);
  });

  it('the file stays 0600 across repeated appends, even if something else loosened it in between', async () => {
    const storeDir = await tmpDir('byok-audit-mode-persist-');
    await appendAuditRecord(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' });
    await fs.chmod(auditLogPath(storeDir), 0o644); // simulate something else loosening it

    await appendAuditRecord(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:01.000Z' });

    const stat = await fs.stat(auditLogPath(storeDir));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('bin/audit-log: finding P1 #3b (STILL-OPEN, now fixed) — chmod happens BEFORE the write, not after', () => {
  it('reasserts 0600 before appendFile is called — no window where the appended line lands in a still-permissive file', async () => {
    const storeDir = await tmpDir('byok-audit-chmod-order-');
    await fs.mkdir(storeDir, { recursive: true });
    const filePath = auditLogPath(storeDir);
    // Pre-existing file, world-readable — simulates one predating this fix
    // (or loosened by something else in between appends).
    await fs.writeFile(filePath, `${JSON.stringify({ kind: 'unpaired', ts: '2025-01-01T00:00:00.000Z' })}\n`, { mode: 0o644 });
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);

    const callOrder: string[] = [];
    let modeObservedBeforeAppend: number | undefined;
    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const originalChmod = handle.chmod.bind(handle);
      const originalAppendFile = handle.appendFile.bind(handle);
      handle.chmod = (async (mode: Parameters<typeof handle.chmod>[0]) => {
        callOrder.push('chmod');
        return originalChmod(mode);
      }) as typeof handle.chmod;
      handle.appendFile = (async (...appendArgs: Parameters<typeof handle.appendFile>) => {
        callOrder.push('appendFile');
        // The critical assertion: by the time the WRITE actually happens,
        // has the tightening already landed on disk? A separate, real
        // `fs.stat` call (not going through the mocked handle) proves it —
        // this is what "no window" means, not just "eventually 0600".
        modeObservedBeforeAppend = (await fs.stat(filePath)).mode & 0o777;
        return originalAppendFile(...appendArgs);
      }) as typeof handle.appendFile;
      return handle;
    });

    try {
      await appendAuditRecord(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:01.000Z' });
    } finally {
      openSpy.mockRestore();
    }

    expect(callOrder).toEqual(['chmod', 'appendFile']);
    expect(modeObservedBeforeAppend).toBe(0o600);

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('tightens the file to 0600 even when appendFile itself fails — the tightening is not gated behind a successful write', async () => {
    const storeDir = await tmpDir('byok-audit-chmod-order-failure-');
    await fs.mkdir(storeDir, { recursive: true });
    const filePath = auditLogPath(storeDir);
    await fs.writeFile(filePath, `${JSON.stringify({ kind: 'unpaired', ts: '2025-01-01T00:00:00.000Z' })}\n`, { mode: 0o644 });

    const realOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      handle.appendFile = (async () => {
        throw new Error('simulated disk-full failure');
      }) as typeof handle.appendFile;
      return handle;
    });

    try {
      await expect(appendAuditRecord(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:01.000Z' })).rejects.toThrow(
        'simulated disk-full failure',
      );
    } finally {
      openSpy.mockRestore();
    }

    // The append itself failed, but the file must still have been
    // tightened to 0600 — the OLD (buggy) code gated the chmod behind a
    // successful appendFile, so a failing write left a pre-existing
    // permissive file exactly as permissive as it started.
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('bin/audit-log: finding P2/#11 (audit half) — size-cap rotation', () => {
  it('rotates (atomically trims to the most recent lines) once the file exceeds the size cap', async () => {
    const storeDir = await tmpDir('byok-audit-rotate-');
    await fs.mkdir(storeDir, { recursive: true });
    const filePath = auditLogPath(storeDir);

    // Pre-seed a file already OVER the cap directly (bypassing individual
    // appendAuditRecord calls, which would be slow/wasteful at this scale).
    // Each line is a valid (record-shaped) 'completed' (TERMINAL —
    // see finding P2 (new)'s `compactPreservingLiveTasks`) record with a
    // distinguishable taskId so the trim boundary is directly observable.
    // Deliberately terminal, not e.g. 'claimed': a non-terminal kind would
    // make every one of these thousands of distinct never-completed taskIds
    // its own live-task anchor under the new rotation logic, defeating the
    // very cap this test exercises — a dedicated test below
    // ('rotation preserves a still-running task's lifecycle anchor')
    // exercises that behavior directly instead. Line count and per-line
    // padding are both deliberately chosen so that this many lines exceeds
    // MAX_AUDIT_LOG_BYTES, but AUDIT_LOG_TRIM_TARGET_LINES of them (what a
    // rotation keeps) does NOT — i.e. proportioned like real (small)
    // record lines, not a pathological single-huge-line case.
    const lineCount = AUDIT_LOG_TRIM_TARGET_LINES * 5;
    const bigLines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      bigLines.push(
        JSON.stringify({
          kind: 'completed',
          ts: '2026-01-01T00:00:00.000Z',
          taskId: `pre-seed-${i}`,
          summaryBytes: 4,
          sessionRef: 'sess',
          padding: 'x'.repeat(500),
        }),
      );
    }
    await fs.writeFile(filePath, `${bigLines.join('\n')}\n`, { mode: 0o600 });
    const beforeSize = (await fs.stat(filePath)).size;
    expect(beforeSize).toBeGreaterThan(MAX_AUDIT_LOG_BYTES);

    // One more real append triggers the rotation check.
    await appendAuditRecord(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:01.000Z' });

    const afterSize = (await fs.stat(filePath)).size;
    expect(afterSize).toBeLessThan(beforeSize);
    expect(afterSize).toBeLessThanOrEqual(MAX_AUDIT_LOG_BYTES);

    const events = await readAuditRecords(storeDir);
    expect(events.length).toBeLessThanOrEqual(AUDIT_LOG_TRIM_TARGET_LINES + 1);
    // Oldest pre-seed lines are gone; the most recent ones (plus the just-appended one) survive.
    expect(events.some((e) => 'taskId' in e && e.taskId === 'pre-seed-0')).toBe(false);
    expect(events.some((e) => 'taskId' in e && e.taskId === `pre-seed-${lineCount - 1}`)).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ kind: 'unpaired' });

    // Rotation reuses atomicWriteFile({mode}) — the mode survives the replace.
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('does not rotate while under the size cap', async () => {
    const storeDir = await tmpDir('byok-audit-no-rotate-');
    for (let i = 0; i < 20; i++) {
      await appendAuditRecord(storeDir, { kind: 'claimed', ts: '2026-01-01T00:00:00.000Z', taskId: `t${i}` });
    }
    const events = await readAuditRecords(storeDir);
    expect(events).toHaveLength(20); // nothing trimmed
  });

  it('finding P2 (new): rotation preserves a still-running (non-terminal) task\'s lifecycle anchor, even though its own events fall entirely in the dropped range — deriveTasksFromRecords still lists it', async () => {
    const storeDir = await tmpDir('byok-audit-rotate-live-task-');
    await fs.mkdir(storeDir, { recursive: true });
    const filePath = auditLogPath(storeDir);

    const lines: string[] = [];
    // The still-running task's ONLY events — old enough that a pure
    // positional trim would evict both, and it never reaches a terminal
    // kind anywhere in the file.
    lines.push(JSON.stringify({ kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 'still-running', runtime: 'pi' }));
    lines.push(JSON.stringify({ kind: 'started', ts: '2026-01-01T00:00:01.000Z', taskId: 'still-running' }));

    // Bulk TERMINAL filler (none of it needs its own anchor) — enough to
    // push the file over the size cap and well past the trim target, so
    // the two lines above fall in the dropped prefix under a naive
    // positional trim.
    const fillerCount = AUDIT_LOG_TRIM_TARGET_LINES * 5;
    for (let i = 0; i < fillerCount; i++) {
      lines.push(
        JSON.stringify({
          kind: 'completed',
          ts: '2026-01-01T00:00:02.000Z',
          taskId: `filler-${i}`,
          summaryBytes: 4,
          sessionRef: 'sess',
          padding: 'x'.repeat(500),
        }),
      );
    }
    await fs.writeFile(filePath, `${lines.join('\n')}\n`, { mode: 0o600 });
    expect((await fs.stat(filePath)).size).toBeGreaterThan(MAX_AUDIT_LOG_BYTES);

    // One more real append triggers the rotation check (same trigger as
    // the test above).
    await appendAuditRecord(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:03.000Z' });

    const events = await readAuditRecords(storeDir);

    // The still-running task's anchor survived rotation even though it's
    // far older than the trim target...
    expect(events.some((e) => 'taskId' in e && e.taskId === 'still-running')).toBe(true);

    // ...and `deriveTasksFromRecords` — the actual `tasks`/`status` reducer
    // — still lists it as Running, rather than forgetting it entirely.
    const tasks = deriveTasksFromRecords(events);
    const stillRunning = tasks.find((t) => t.taskId === 'still-running');
    expect(stillRunning).toBeDefined();
    expect(stillRunning?.state).toBe('Running');

    // The bulk terminal filler did NOT all get individually anchored —
    // rotation still actually bounds the file, since each filler task has
    // its OWN terminal event and needs no anchor.
    expect(events.some((e) => 'taskId' in e && e.taskId === 'filler-0')).toBe(false);
    expect(events.length).toBeLessThan(AUDIT_LOG_TRIM_TARGET_LINES + 10);
  });

  it('finding P2 (new, round 2): many (>> cap) never-terminal tasks do not defeat the rotation cap — anchors are themselves bounded, dropping the oldest, and a recently-touched running task still survives', async () => {
    const storeDir = await tmpDir('byok-audit-rotate-anchor-cap-');
    await fs.mkdir(storeDir, { recursive: true });
    const filePath = auditLogPath(storeDir);

    const lines: string[] = [];
    // Far more distinct non-terminal (never-completed) taskIds than
    // MAX_LIVE_TASK_ANCHORS — every one of these would have gotten its own
    // anchor under the un-capped round-1-only logic, defeating the size cap
    // this test exercises.
    const leakedCount = MAX_LIVE_TASK_ANCHORS * 3;
    for (let i = 0; i < leakedCount; i++) {
      lines.push(JSON.stringify({ kind: 'claimed', ts: '2026-01-01T00:00:00.000Z', taskId: `leaked-${i}` }));
    }
    // The most RECENTLY-touched non-terminal task (last of the candidates,
    // by line index) — must survive the cap, which keeps the most recent
    // and drops the oldest.
    lines.push(JSON.stringify({ kind: 'started', ts: '2026-01-01T00:00:01.000Z', taskId: 'recent-running' }));

    // Bulk TERMINAL filler (none of it needs its own anchor) — enough to
    // push the file over the size cap and well past the trim target.
    const fillerCount = AUDIT_LOG_TRIM_TARGET_LINES * 5;
    for (let i = 0; i < fillerCount; i++) {
      lines.push(
        JSON.stringify({
          kind: 'completed',
          ts: '2026-01-01T00:00:02.000Z',
          taskId: `filler-${i}`,
          summaryBytes: 4,
          sessionRef: 'sess',
          padding: 'x'.repeat(500),
        }),
      );
    }
    await fs.writeFile(filePath, `${lines.join('\n')}\n`, { mode: 0o600 });
    expect((await fs.stat(filePath)).size).toBeGreaterThan(MAX_AUDIT_LOG_BYTES);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // One more real append triggers the rotation check.
    await appendAuditRecord(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:03.000Z' });

    const events = await readAuditRecords(storeDir);

    // The file stays BOUNDED: at most the trim target plus the anchor cap —
    // never one anchor per leaked task (which would be ~leakedCount lines,
    // far larger than this bound).
    expect(events.length).toBeLessThanOrEqual(AUDIT_LOG_TRIM_TARGET_LINES + MAX_LIVE_TASK_ANCHORS + 10);

    // The most recently-touched non-terminal task is still preserved...
    expect(events.some((e) => 'taskId' in e && e.taskId === 'recent-running')).toBe(true);

    // ...but the OLDEST leaked non-terminal tasks were dropped once the cap
    // was exceeded (only the most recent MAX_LIVE_TASK_ANCHORS survive).
    expect(events.some((e) => 'taskId' in e && e.taskId === 'leaked-0')).toBe(false);

    // Exactly one warning was logged for the whole rotation — not one per
    // dropped anchor. Asserted BEFORE mockRestore(), which clears call history.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('MAX_LIVE_TASK_ANCHORS');

    warnSpy.mockRestore();
  });
});

describe('bin/audit-log: createAuditAppender', () => {
  it('serializes concurrent appends so they land in call order even though each write is async', async () => {
    const storeDir = await tmpDir('byok-audit-appender-');
    const appender = createAuditAppender(storeDir);

    const events: DaemonRecord[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'claimed',
      ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      taskId: `t${i}`,
    }));
    for (const event of events) appender.append(event); // fire-and-forget from the caller's point of view

    // Poll rather than a fixed sleep: each append now does several fs calls
    // (mkdir/chmod/open/appendFile/chmod/close/stat — see finding P1 #3's
    // 0600 re-assertion and P2/#11's size-cap check, both in
    // `appendAuditRecord`), so a hardcoded short wait is exactly the kind of
    // timing assumption real disk I/O variance can make flaky.
    let read: Awaited<ReturnType<typeof readAuditRecords>> = [];
    await vi.waitFor(async () => {
      read = await readAuditRecords(storeDir);
      expect(read).toHaveLength(events.length);
    });

    expect(read.map((e) => ('taskId' in e ? e.taskId : undefined))).toEqual(events.map((e) => ('taskId' in e ? e.taskId : undefined)));
  });

  it('reports a failing write via onError, and still accepts later events afterward', async () => {
    const parent = await tmpDir('byok-audit-appender-error-');
    // A storeDir that is actually a FILE (not a directory) makes
    // `fs.mkdir(storeDir, {recursive:true})` reject reliably — the simplest
    // induced failure that doesn't depend on filesystem permissions.
    const brokenStoreDir = path.join(parent, 'broken-store-dir');
    await fs.writeFile(brokenStoreDir, 'x');

    const errors: unknown[] = [];
    const appender = createAuditAppender(brokenStoreDir, (err) => errors.push(err));
    appender.append({ kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' });
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1));

    // A subsequent append against a WORKING storeDir on the same appender
    // instance would be a different chain (each `createAuditAppender` call
    // owns its own chain) — what matters here is the failed append didn't
    // leave the returned function itself unusable for a fixed storeDir.
    await fs.rm(brokenStoreDir, { force: true });
    appender.append({ kind: 'unpaired', ts: '2026-01-01T00:00:01.000Z' });
    await vi.waitFor(async () => expect((await readAuditRecords(brokenStoreDir)).length).toBeGreaterThanOrEqual(1));
  });
});
