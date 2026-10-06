import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { RuntimeAdapter, Session } from '../types';
import {
  runAdapterCapabilityConformance,
  type AdapterCapabilityFixture,
} from './fixtures/adapter-capability-conformance';
import { startPreparedOperation } from './fixtures/prepared-operation';

type QualifiedRuntime = 'claude' | 'codex';

async function createFixture(id: QualifiedRuntime): Promise<AdapterCapabilityFixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `byok-${id}-conformance-`));
  const home = path.join(directory, 'home');
  await fs.mkdir(home);
  const receipt = path.join(directory, 'rpc.jsonl');
  const binary = fileURLToPath(new URL(`./fixtures/fake-${id}.mjs`, import.meta.url));
  const invocations: string[][] = [];
  const sessions: Session[] = [];
  const resolveBin = vi.fn(() => ({ command: binary, source: 'path' as const }));
  const spawnFn: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    invocations.push([...args]);
    return spawn(command, args, options);
  }) as typeof spawn;
  const adapter: RuntimeAdapter = id === 'claude'
    ? new ClaudeAdapter({ resolveBin, spawnFn })
    : new CodexAdapter({ resolveBin, spawnFn });
  const sessionRef = id === 'claude' ? 'fake-claude-session-1' : 'fake-thread-1';

  async function frames(): Promise<Array<{ method?: string; params?: unknown }>> {
    return (await fs.readFile(receipt, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  }

  return {
    adapter,
    sessionRef,
    mismatchedIdentityEnvironment: id === 'claude'
      ? { FAKE_CLAUDE_REPORTED_SESSION_ID: 'different-session' }
      : { FAKE_CODEX_REPORTED_THREAD_ID: 'different-thread' },
    async start(input = {}) {
      const session = await startPreparedOperation(adapter, {
        instruction: 'conformance turn',
        policy: { mode: 'auto' },
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      }, {
        workspaceDir: directory,
        policy: { mode: 'auto' },
        // Synthetic HOME and explicit env: never inherit real provider credentials.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          ...(id === 'codex' ? { FAKE_CODEX_RPC_RECEIPT: receipt } : {}),
          ...(input.running ? id === 'claude'
            ? { FAKE_CLAUDE_HANG_AFTER_TOOL: '1' }
            : { FAKE_CODEX_HANG: '1' } : {}),
          ...input.env,
        },
      });
      sessions.push(session);
      return session;
    },
    async assertResumeReceipt() {
      if (id === 'claude') {
        const invocation = invocations.find((args) => args.includes('--resume'));
        expect(invocation).toBeDefined();
        expect(invocation![invocation!.indexOf('--resume') + 1]).toBe(sessionRef);
      } else {
        const recorded = await frames();
        expect(recorded).toContainEqual(expect.objectContaining({
          method: 'thread/resume', params: expect.objectContaining({ threadId: sessionRef }),
        }));
        expect(recorded.some(({ method }) => method === 'thread/start')).toBe(false);
      }
    },
    async assertSteerReceipt(text) {
      if (id !== 'codex') throw new Error('Claude has no qualified steering receipt');
      expect(await frames()).toContainEqual(expect.objectContaining({
        method: 'turn/steer',
        params: expect.objectContaining({ expectedTurnId: 'turn-1', input: [{ type: 'text', text }] }),
      }));
    },
    assertNoRuntimeInvocation() {
      expect(resolveBin).not.toHaveBeenCalled();
      expect(invocations).toEqual([]);
    },
    async dispose() {
      try {
        const results = await Promise.allSettled(sessions.map((session) => session.close()));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  };
}

runAdapterCapabilityConformance({
  id: 'claude', steer: false, permissionModes: ['auto', 'readonly', 'plan'],
  create: () => createFixture('claude'),
});
runAdapterCapabilityConformance({
  id: 'codex', steer: true, permissionModes: ['auto'],
  create: () => createFixture('codex'),
});
