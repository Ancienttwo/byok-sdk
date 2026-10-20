import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import type { RuntimeAdapter, Session } from '../types';
import {
  runAdapterCapabilityConformance,
  type AdapterCapabilityFixture,
} from './fixtures/adapter-capability-conformance';
import { startPreparedOperation } from './fixtures/prepared-operation';

type QualifiedRuntime = 'claude' | 'codex' | 'grok';

async function createFixture(id: QualifiedRuntime): Promise<AdapterCapabilityFixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `byok-${id}-conformance-`));
  const home = path.join(directory, 'home');
  await fs.mkdir(home);
  const receipt = path.join(directory, 'rpc.jsonl');
  const binary = fileURLToPath(new URL(id === 'grok' ? './fixtures/fake-acp-agent.mjs' : `./fixtures/fake-${id}.mjs`, import.meta.url));
  const invocations: string[][] = [];
  const sessions: Session[] = [];
  const resolveBin = vi.fn(() => ({ command: binary, source: 'path' as const }));
  const spawnFn: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    invocations.push([...args]);
    return spawn(command, args, options);
  }) as typeof spawn;
  const adapter: RuntimeAdapter = id === 'claude'
    ? new ClaudeAdapter({ resolveBin, spawnFn })
    : id === 'codex' ? new CodexAdapter({ resolveBin, spawnFn }) : new GrokAdapter({ resolveBin, spawnFn });
  const sessionRef = { claude: 'fake-claude-session-1', codex: 'fake-thread-1', grok: 'fake-grok-session' }[id];

  async function frames(): Promise<Array<{ method?: string; params?: unknown }>> {
    return (await fs.readFile(receipt, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  }

  return {
    adapter,
    sessionRef,
    ...(id === 'grok' ? {} : {
      mismatchedIdentityEnvironment: id === 'claude'
        ? { FAKE_CLAUDE_REPORTED_SESSION_ID: 'different-session' }
        : { FAKE_CODEX_REPORTED_THREAD_ID: 'different-thread' },
    }),
    async start(input = {}) {
      const session = await startPreparedOperation(adapter, {
        instruction: 'conformance turn',
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      }, {
        workspaceDir: directory,
        // Synthetic HOME and explicit env: never inherit real provider credentials.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          ...(id === 'codex' ? { FAKE_CODEX_RPC_RECEIPT: receipt } : {}),
          ...(id === 'grok' ? { FAKE_ACP_LOG: receipt } : {}),
          ...(input.running ? { claude: { FAKE_CLAUDE_HANG_AFTER_TOOL: '1' }, codex: { FAKE_CODEX_HANG: '1' }, grok: { FAKE_ACP_HANG: '1' } }[id] : {}),
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
      } else if (id === 'grok') {
        const opens = (await frames()).filter((fact) => (fact as { kind?: string }).kind === 'open');
        expect(opens).toContainEqual(expect.objectContaining({
          method: 'session/resume', params: expect.objectContaining({ sessionId: sessionRef }),
        }));
        expect(opens.some(({ method }) => method === 'session/new')).toBe(false);
      } else {
        const recorded = await frames();
        expect(recorded).toContainEqual(expect.objectContaining({
          method: 'thread/resume', params: expect.objectContaining({ threadId: sessionRef }),
        }));
        expect(recorded.some(({ method }) => method === 'thread/start')).toBe(false);
      }
    },
    async assertSteerReceipt(text) {
      if (id !== 'codex') throw new Error(`${id} has no qualified steering receipt`);
      expect(await frames()).toContainEqual(expect.objectContaining({
        method: 'turn/steer',
        params: expect.objectContaining({ expectedTurnId: 'turn-1', input: [{ type: 'text', text }] }),
      }));
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
  id: 'claude', steer: false, resumeReportsIdentity: true,
  create: () => createFixture('claude'),
});
runAdapterCapabilityConformance({
  id: 'codex', steer: true, resumeReportsIdentity: true,
  create: () => createFixture('codex'),
});
// ACP `session/resume` answers with no session id: the resumed identity is the requested one.
runAdapterCapabilityConformance({
  id: 'grok', steer: false, resumeReportsIdentity: false,
  create: () => createFixture('grok'),
});
