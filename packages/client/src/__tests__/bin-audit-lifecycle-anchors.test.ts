import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAuditEvent,
  AUDIT_LOG_TRIM_TARGET_LINES,
  auditLogPath,
  MAX_AUDIT_LOG_BYTES,
  MAX_LIVE_TASK_ANCHORS,
  readAuditEvents,
} from '../bin/audit-log';
import { deriveTasksFromEvents } from '../bin/tasks-view';

const stores: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => fs.rm(store, { recursive: true, force: true })));
});

describe('19.2: audit rotation retains state-bearing lifecycle anchors', () => {
  it.each(['dropped prefix', 'retained tail'] as const)(
    'keeps a quiet running task when its artifact is in the %s',
    async (artifactPosition) => {
      const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-audit-lifecycle-anchors-'));
      stores.push(storeDir);
      const ts = '2026-01-01T00:00:00.000Z';
      const artifact = (taskId: string) => JSON.stringify({
        kind: 'artifact', ts, taskId, name: 'result.txt', contentType: 'text/plain', inlineSize: 4,
      });
      const observations = [artifact('still-running'), artifact('artifact-only')];
      const lines = [
        JSON.stringify({ kind: 'offered', ts, taskId: 'still-running', runtime: 'pi' }),
        JSON.stringify({ kind: 'started', ts, taskId: 'still-running' }),
      ];
      if (artifactPosition === 'dropped prefix') lines.push(...observations);
      // Real on-disk rotation threshold and retained-tail size, with inert
      // terminal filler so no unrelated live task needs an anchor.
      const fillerCount = AUDIT_LOG_TRIM_TARGET_LINES * 5;
      for (let i = 0; i < fillerCount; i++) {
        lines.push(JSON.stringify({
          kind: 'completed', ts, taskId: `filler-${i}`, summarySize: 4,
          sessionRef: 'fixture-session', padding: 'x'.repeat(500),
        }));
      }
      if (artifactPosition === 'retained tail') lines.push(...observations);
      const filePath = auditLogPath(storeDir);
      await fs.writeFile(filePath, `${lines.join('\n')}\n`, { mode: 0o600 });
      expect((await fs.stat(filePath)).size).toBeGreaterThan(MAX_AUDIT_LOG_BYTES);

      await appendAuditEvent(storeDir, { kind: 'unpaired', ts });
      const events = await readAuditEvents(storeDir);
      const tasks = deriveTasksFromEvents(events);
      expect(tasks.find((task) => task.taskId === 'still-running')?.state).toBe('Running');
      expect(events[0]).toMatchObject({ kind: 'started', taskId: 'still-running' });
      expect(events.some((event) => event.kind === 'artifact')).toBe(artifactPosition === 'retained tail');
      expect(tasks.some((task) => task.taskId === 'artifact-only')).toBe(false);
      expect(events.some((event) => 'taskId' in event && event.taskId === 'filler-0')).toBe(false);
      expect(events).toHaveLength(AUDIT_LOG_TRIM_TARGET_LINES + 1);
      expect(events.length).toBeLessThanOrEqual(AUDIT_LOG_TRIM_TARGET_LINES + MAX_LIVE_TASK_ANCHORS);
      expect((await fs.stat(filePath)).size).toBeLessThanOrEqual(MAX_AUDIT_LOG_BYTES);
      expect(events.at(-1)?.kind).toBe('unpaired');
    },
  );
});
