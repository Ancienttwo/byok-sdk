import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TaskOfferPayload } from '@byok-sdk/protocol';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';

const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

interface ProcessTreeReceipt {
  rootPid: number;
  descendantPid: number;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readReceipt(file: string): Promise<ProcessTreeReceipt> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const receipt = JSON.parse(await fs.readFile(file, 'utf8')) as ProcessTreeReceipt;
      if (receipt.rootPid > 0 && receipt.descendantPid > 0) return receipt;
    } catch {
      // The fixture writes asynchronously after spawn; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('process-tree receipt was not written within 2 seconds');
}

describe('bundled runtime process-tree disposal', () => {
  it('escalates a TERM-resistant POSIX process group before resolving close', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-process-tree-escalation-'));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const offer: TaskOfferPayload = { instruction: 'stay alive', policy: { mode: 'auto' } };
    const adapter = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'package' }) });
    const session = await startPreparedOperation(adapter, offer, {
      workspaceDir,
      policy: offer.policy,
      env: {
        ...process.env,
        FAKE_PI_PROCESS_TREE_FILE: receiptFile,
        FAKE_PI_HANG_AFTER_TOOL: '1',
        FAKE_PI_IGNORE_TERM: '1',
      },
    });
    const receipt = await readReceipt(receiptFile);
    const startedAt = Date.now();
    try {
      await session.close();
      if (process.platform !== 'win32') expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
      expect(processExists(receipt.rootPid)).toBe(false);
      expect(processExists(receipt.descendantPid)).toBe(false);
    } finally {
      for (const pid of [receipt.descendantPid, receipt.rootPid]) {
        if (!processExists(pid)) continue;
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  it('Pi close resolves only after its real root and descendant are both gone', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-process-tree-'));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const offer: TaskOfferPayload = { instruction: 'stay alive', policy: { mode: 'auto' } };
    const adapter = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'package' }) });
    const session = await startPreparedOperation(adapter, offer, {
      workspaceDir,
      policy: offer.policy,
      env: { ...process.env, FAKE_PI_PROCESS_TREE_FILE: receiptFile },
    });
    const receipt = await readReceipt(receiptFile);

    try {
      expect(processExists(receipt.rootPid)).toBe(true);
      expect(processExists(receipt.descendantPid)).toBe(true);
      await session.interrupt();
      await session.close();
      expect(processExists(receipt.rootPid)).toBe(false);
      expect(processExists(receipt.descendantPid)).toBe(false);
    } finally {
      for (const pid of [receipt.descendantPid, receipt.rootPid]) {
        if (processExists(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // A process that exited between the probe and cleanup is already safe.
          }
        }
      }
    }
  });

  it.each([
    {
      runtime: 'Claude',
      adapter: () => new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) }),
      env: (receiptFile: string) => ({ FAKE_CLAUDE_PROCESS_TREE_FILE: receiptFile, FAKE_CLAUDE_HANG_AFTER_TOOL: '1' }),
    },
    {
      runtime: 'Codex',
      adapter: () => new CodexAdapter({ resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }) }),
      env: (receiptFile: string) => ({ FAKE_CODEX_PROCESS_TREE_FILE: receiptFile, FAKE_CODEX_HANG: '1' }),
    },
  ])('$runtime close resolves only after its real root and descendant are both gone', async ({ runtime, adapter, env }) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `byok-${runtime.toLowerCase()}-process-tree-`));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const offer: TaskOfferPayload = { instruction: 'stay alive', policy: { mode: 'auto' } };
    const session = await startPreparedOperation(adapter(), offer, {
      workspaceDir,
      policy: offer.policy,
      env: { ...process.env, ...env(receiptFile) },
    });
    const receipt = await readReceipt(receiptFile);

    try {
      expect(processExists(receipt.rootPid)).toBe(true);
      expect(processExists(receipt.descendantPid)).toBe(true);
      await session.interrupt();
      await session.close();
      expect(processExists(receipt.rootPid)).toBe(false);
      expect(processExists(receipt.descendantPid)).toBe(false);
    } finally {
      for (const pid of [receipt.descendantPid, receipt.rootPid]) {
        if (!processExists(pid)) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // A process that exited between the probe and cleanup is already safe.
        }
      }
    }
  });
});
