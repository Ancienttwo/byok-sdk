import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '../index';
import {
  appendAuditEvent,
  AUDIT_LOG_TRIM_TARGET_LINES,
  auditLogPath,
  createAuditAppender,
  followAuditLog,
  MAX_AUDIT_LOG_BYTES,
  readAuditEvents,
} from '../bin/audit-log';

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

describe('bin/audit-log: finding P1 #3 (SECURITY) — redaction, 0600 file, 0700 storeDir', () => {
  it('a secret-like tool_use input / tool_result output / inline artifact bytes are NOT present verbatim in audit.jsonl, and the file is 0600', async () => {
    const storeDir = await tmpDir('byok-audit-redact-');
    const secretApiKey = 'sk-live-SUPER-SECRET-1234567890abcdef';
    const secretToolOutput = 'password=hunter2\nAPI_KEY=sk-another-secret-value';
    const secretInlineBase64 = Buffer.from('# secret file contents\nTOKEN=abcdef123456').toString('base64');

    await appendAuditEvent(storeDir, {
      kind: 'progress',
      ts: '2026-01-01T00:00:00.000Z',
      taskId: 't1',
      event: {
        type: 'tool_use',
        tool: 'bash',
        input: { command: `curl -H "Authorization: Bearer ${secretApiKey}" https://example.invalid` },
      },
    });
    await appendAuditEvent(storeDir, {
      kind: 'progress',
      ts: '2026-01-01T00:00:01.000Z',
      taskId: 't1',
      event: { type: 'tool_result', tool: 'bash', output: secretToolOutput },
    });
    await appendAuditEvent(storeDir, {
      kind: 'artifact',
      ts: '2026-01-01T00:00:02.000Z',
      taskId: 't1',
      name: 'secrets.txt',
      contentType: 'text/plain',
      inline: secretInlineBase64,
    });

    const raw = await fs.readFile(auditLogPath(storeDir), 'utf8');
    expect(raw).not.toContain(secretApiKey);
    expect(raw).not.toContain(secretToolOutput);
    expect(raw).not.toContain(secretInlineBase64);
    expect(raw).not.toContain('hunter2');

    // Still useful for triage: tool NAMES, taskId, and sizes/counts survive.
    expect(raw).toContain('"tool":"bash"');
    expect(raw).toContain('inputSize');
    expect(raw).toContain('outputSize');
    expect(raw).toContain('inlineSize');

    const stat = await fs.stat(auditLogPath(storeDir));
    expect(stat.mode & 0o777).toBe(0o600);

    // Reading it back degrades honestly to size placeholders — never the raw secret.
    const events = await readAuditEvents(storeDir);
    const serializedReadBack = JSON.stringify(events);
    expect(serializedReadBack).not.toContain(secretApiKey);
    expect(serializedReadBack).not.toContain(secretToolOutput);
    expect(serializedReadBack).not.toContain(secretInlineBase64);
  });

  it('a pre-existing storeDir with a permissive mode gets locked down to 0700 on append', async () => {
    const parent = await tmpDir('byok-audit-storedir-mode-parent-');
    const storeDir = path.join(parent, 'permissive-store');
    await fs.mkdir(storeDir, { mode: 0o755 });
    const before = await fs.stat(storeDir);
    expect(before.mode & 0o777).toBe(0o755);

    await appendAuditEvent(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' });

    const after = await fs.stat(storeDir);
    expect(after.mode & 0o777).toBe(0o700);
  });

  it('the file stays 0600 across repeated appends, even if something else loosened it in between', async () => {
    const storeDir = await tmpDir('byok-audit-mode-persist-');
    await appendAuditEvent(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' });
    await fs.chmod(auditLogPath(storeDir), 0o644); // simulate something else loosening it

    await appendAuditEvent(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:01.000Z' });

    const stat = await fs.stat(auditLogPath(storeDir));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('bin/audit-log: finding P2/#11 (audit half) — size-cap rotation', () => {
  it('rotates (atomically trims to the most recent lines) once the file exceeds the size cap', async () => {
    const storeDir = await tmpDir('byok-audit-rotate-');
    await fs.mkdir(storeDir, { recursive: true });
    const filePath = auditLogPath(storeDir);

    // Pre-seed a file already OVER the cap directly (bypassing individual
    // appendAuditEvent calls, which would be slow/wasteful at this scale).
    // Each line is a valid (already-redacted-shaped) 'claimed' record with a
    // distinguishable taskId so the trim boundary is directly observable.
    // Line count and per-line padding are both deliberately chosen so that
    // this many lines exceeds MAX_AUDIT_LOG_BYTES, but AUDIT_LOG_TRIM_TARGET_LINES
    // of them (what a rotation keeps) does NOT — i.e. proportioned like real
    // (small) redacted lines, not a pathological single-huge-line case.
    const lineCount = AUDIT_LOG_TRIM_TARGET_LINES * 5;
    const bigLines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      bigLines.push(JSON.stringify({ kind: 'claimed', ts: '2026-01-01T00:00:00.000Z', taskId: `pre-seed-${i}`, padding: 'x'.repeat(500) }));
    }
    await fs.writeFile(filePath, `${bigLines.join('\n')}\n`, { mode: 0o600 });
    const beforeSize = (await fs.stat(filePath)).size;
    expect(beforeSize).toBeGreaterThan(MAX_AUDIT_LOG_BYTES);

    // One more real append triggers the rotation check.
    await appendAuditEvent(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:01.000Z' });

    const afterSize = (await fs.stat(filePath)).size;
    expect(afterSize).toBeLessThan(beforeSize);
    expect(afterSize).toBeLessThanOrEqual(MAX_AUDIT_LOG_BYTES);

    const events = await readAuditEvents(storeDir);
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
      await appendAuditEvent(storeDir, { kind: 'claimed', ts: '2026-01-01T00:00:00.000Z', taskId: `t${i}` });
    }
    const events = await readAuditEvents(storeDir);
    expect(events).toHaveLength(20); // nothing trimmed
  });
});

describe('bin/audit-log: finding P2/#11 (audit half) — followAuditLog byte-offset tracking', () => {
  it('sees every event across many sequential appends, in order, exactly once (not a full re-read/re-parse each poll)', async () => {
    const storeDir = await tmpDir('byok-audit-follow-many-');
    const filePath = auditLogPath(storeDir);

    const seen: DaemonEvent[] = [];
    const controller = new AbortController();
    const followPromise = followAuditLog(filePath, (e) => seen.push(e), {
      signal: controller.signal,
      pollIntervalMs: 10,
      fromEnd: true,
    });

    const N = 50;
    for (let i = 0; i < N; i++) {
      await appendAuditEvent(storeDir, {
        kind: 'claimed',
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        taskId: `t${i}`,
      });
    }

    await vi.waitFor(() => expect(seen).toHaveLength(N));
    expect(seen.map((e) => ('taskId' in e ? e.taskId : undefined))).toEqual(Array.from({ length: N }, (_, i) => `t${i}`));

    controller.abort();
    await followPromise;
  });

  it('decodes multi-byte UTF-8 characters correctly (byte-safe split on raw 0x0a, never a partially-decoded chunk)', async () => {
    const storeDir = await tmpDir('byok-audit-follow-utf8-');
    const filePath = auditLogPath(storeDir);

    const seen: DaemonEvent[] = [];
    const controller = new AbortController();
    const followPromise = followAuditLog(filePath, (e) => seen.push(e), {
      signal: controller.signal,
      pollIntervalMs: 5,
      fromEnd: true,
    });

    const taskId = 'task-emoji-\u{1F680}-日本語'; // rocket emoji + Japanese, multi-byte in UTF-8
    await appendAuditEvent(storeDir, { kind: 'claimed', ts: '2026-01-01T00:00:00.000Z', taskId });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ kind: 'claimed', taskId });

    controller.abort();
    await followPromise;
  });

  it('recovers (rather than throwing) if the log is rotated/replaced with a smaller file while a follow session is attached', async () => {
    const storeDir = await tmpDir('byok-audit-follow-rotate-');
    const filePath = auditLogPath(storeDir);
    // Build up several lines first so the pre-rotation file is
    // unambiguously LARGER than the single line it gets replaced with below
    // — matches the real shape `rotateIfNeeded` produces (trims a
    // much-larger, over-cap file down to a small bounded target), unlike a
    // same-size swap the offset-reset heuristic isn't meant to cover.
    for (let i = 0; i < 10; i++) {
      await appendAuditEvent(storeDir, {
        kind: 'claimed',
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        taskId: `pre-rotation-${i}`,
      });
    }

    const seen: DaemonEvent[] = [];
    const controller = new AbortController();
    const followPromise = followAuditLog(filePath, (e) => seen.push(e), {
      signal: controller.signal,
      pollIntervalMs: 10,
      fromEnd: true,
    });

    // Simulate a rotation: replace the file with a single, much smaller
    // line (mirrors what appendAuditEvent's own size-cap rotation does).
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.writeFile(filePath, `${JSON.stringify({ kind: 'paired', ts: '2026-01-01T00:00:20.000Z', deviceId: 'dev-1' })}\n`, {
      mode: 0o600,
    });

    await vi.waitFor(() => expect(seen.some((e) => e.kind === 'paired')).toBe(true));

    controller.abort();
    await followPromise;
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

    // Poll rather than a fixed sleep: each append now does several fs calls
    // (mkdir/chmod/open/appendFile/chmod/close/stat — see finding P1 #3's
    // 0600 re-assertion and P2/#11's size-cap check, both in
    // `appendAuditEvent`), so a hardcoded short wait is exactly the kind of
    // timing assumption real disk I/O variance can make flaky.
    let read: Awaited<ReturnType<typeof readAuditEvents>> = [];
    await vi.waitFor(async () => {
      read = await readAuditEvents(storeDir);
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
