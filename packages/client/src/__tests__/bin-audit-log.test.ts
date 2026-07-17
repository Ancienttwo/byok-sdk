import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '../index';
import { appendAuditEvent, auditLogPath, createAuditAppender, followAuditLog, readAuditEvents } from '../bin/audit-log';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function connectionEvent(state: 'open' | 'closed' | 'connecting' | 'degraded' | 'revoked', ts: string): DaemonEvent {
  return { kind: 'connection', ts, state };
}

describe('bin/audit-log: appendAuditEvent / readAuditEvents', () => {
  it('appends events as one JSON line each, oldest first, and reads them back', async () => {
    const storeDir = await tmpDir('byok-audit-');
    const e1 = connectionEvent('open', '2026-01-01T00:00:00.000Z');
    const e2: DaemonEvent = { kind: 'offered', ts: '2026-01-01T00:00:01.000Z', taskId: 't1', runtime: 'pi' };

    await appendAuditEvent(storeDir, e1);
    await appendAuditEvent(storeDir, e2);

    const raw = await fs.readFile(auditLogPath(storeDir), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);

    const events = await readAuditEvents(storeDir);
    expect(events).toEqual([e1, e2]);
  });

  it('returns [] when the log does not exist yet', async () => {
    const storeDir = await tmpDir('byok-audit-missing-');
    expect(await readAuditEvents(storeDir)).toEqual([]);
  });

  it('skips a corrupt/blank line instead of throwing', async () => {
    const storeDir = await tmpDir('byok-audit-corrupt-');
    const good: DaemonEvent = { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' };
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(auditLogPath(storeDir), `${JSON.stringify(good)}\n\nnot json at all\n{"missing":"kind and ts"}\n`);

    const events = await readAuditEvents(storeDir);
    expect(events).toEqual([good]);
  });

  it('drops a torn trailing line with no terminating newline (a write caught mid-flush) rather than misreading it', async () => {
    const storeDir = await tmpDir('byok-audit-torn-');
    const good: DaemonEvent = { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' };
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(auditLogPath(storeDir), `${JSON.stringify(good)}\n{"kind":"paired","ts":"2026-01-01T00:00:0`);

    const events = await readAuditEvents(storeDir);
    expect(events).toEqual([good]);
  });
});

describe('bin/audit-log: createAuditAppender', () => {
  it('serializes concurrent appends so they land in call order even though each write is async', async () => {
    const storeDir = await tmpDir('byok-audit-appender-');
    const appender = createAuditAppender(storeDir);

    const events: DaemonEvent[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'claimed',
      ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      taskId: `t${i}`,
    }));
    for (const event of events) appender(event); // fire-and-forget from the caller's point of view

    await new Promise((resolve) => setTimeout(resolve, 50));

    const read = await readAuditEvents(storeDir);
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
    appender({ kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' });
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1));

    // A subsequent append against a WORKING storeDir on the same appender
    // instance would be a different chain (each `createAuditAppender` call
    // owns its own chain) — what matters here is the failed append didn't
    // leave the returned function itself unusable for a fixed storeDir.
    await fs.rm(brokenStoreDir, { force: true });
    appender({ kind: 'unpaired', ts: '2026-01-01T00:00:01.000Z' });
    await vi.waitFor(async () => expect((await readAuditEvents(brokenStoreDir)).length).toBeGreaterThanOrEqual(1));
  });
});

describe('bin/audit-log: followAuditLog', () => {
  it('fromEnd: false replays existing lines, then streams newly appended ones, and stops promptly on abort', async () => {
    const storeDir = await tmpDir('byok-audit-follow-');
    const filePath = auditLogPath(storeDir);
    await appendAuditEvent(storeDir, connectionEvent('open', '2026-01-01T00:00:00.000Z'));

    const seen: DaemonEvent[] = [];
    const controller = new AbortController();
    const followPromise = followAuditLog(filePath, (e) => seen.push(e), {
      signal: controller.signal,
      pollIntervalMs: 10,
      fromEnd: false,
    });

    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    expect(seen[0]).toMatchObject({ kind: 'connection', state: 'open' });

    await appendAuditEvent(storeDir, { kind: 'offered', ts: '2026-01-01T00:00:01.000Z', taskId: 't1' });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
    expect(seen[1]).toMatchObject({ kind: 'offered', taskId: 't1' });

    controller.abort();
    await followPromise;

    // Appending after abort must never be observed — the loop already exited.
    await appendAuditEvent(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:02.000Z' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(2);
  });

  it('fromEnd: true (the default `tasks --follow` uses) ignores pre-existing lines and only streams new ones', async () => {
    const storeDir = await tmpDir('byok-audit-follow-fromend-');
    const filePath = auditLogPath(storeDir);
    await appendAuditEvent(storeDir, connectionEvent('open', '2026-01-01T00:00:00.000Z'));

    const seen: DaemonEvent[] = [];
    const controller = new AbortController();
    const followPromise = followAuditLog(filePath, (e) => seen.push(e), {
      signal: controller.signal,
      pollIntervalMs: 10,
      fromEnd: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(0); // the pre-existing line was skipped

    await appendAuditEvent(storeDir, { kind: 'offered', ts: '2026-01-01T00:00:01.000Z', taskId: 't1' });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    expect(seen[0]).toMatchObject({ kind: 'offered', taskId: 't1' });

    controller.abort();
    await followPromise;
  });

  it('tolerates the log not existing yet at all, then picks up events once it is created', async () => {
    const storeDir = await tmpDir('byok-audit-follow-nofile-');
    const filePath = auditLogPath(storeDir);

    const seen: DaemonEvent[] = [];
    const controller = new AbortController();
    const followPromise = followAuditLog(filePath, (e) => seen.push(e), {
      signal: controller.signal,
      pollIntervalMs: 10,
      fromEnd: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    await appendAuditEvent(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));

    controller.abort();
    await followPromise;
  });

  it('resolves promptly on abort even mid-poll-interval, rather than waiting out the full interval', async () => {
    const storeDir = await tmpDir('byok-audit-follow-abort-speed-');
    const filePath = auditLogPath(storeDir);
    const controller = new AbortController();
    const followPromise = followAuditLog(filePath, () => {}, { signal: controller.signal, pollIntervalMs: 5000 });

    const start = Date.now();
    controller.abort();
    await followPromise;
    expect(Date.now() - start).toBeLessThan(1000); // well under the 5s poll interval
  });
});
