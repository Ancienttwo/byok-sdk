import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const sessions: Session[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(policy: 'excluded' | 'inherit' | undefined, scope: 'writer' | 'reader' | 'non-agent', extra = {}) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-startup-')));
  dirs.push(home);
  const receipt = path.join(home, 'rpc.jsonl');
  const launches: string[][] = [];
  const spawnFn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    // Observe the actual process boundary, before initialize or any thread request.
    expect(existsSync(receipt)).toBe(false);
    launches.push([...args]);
    return spawn(command, args, options);
  }) as typeof spawn;
  const adapter = new CodexAdapter({
    resolveBin: () => ({ command: fixture, source: 'path' }), spawnFn,
    ...(policy === undefined ? {} : { agentUserMcpServers: policy }),
  });
  const resources = {
    workspaceDir: home,
    ...(scope === 'writer' ? { agentHome: home } : {}),
    ...(scope === 'reader' ? { reader: { canonicalHome: home } } : {}),
    env: {
      PATH: process.env.PATH, HOME: home, CODEX_HOME: home,
      FAKE_CODEX_RPC_RECEIPT: receipt,
      FAKE_CODEX_USER_CONFIG: JSON.stringify({
        model_provider: 'custom', features: { plugins: true },
        plugins: { 'example@market': { enabled: true } },
      }),
      ...extra,
    },
  };
  const frames = async () => (await fs.readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { adapter, resources, launches, frames };
}

for (const mode of ['fresh', 'resume'] as const) {
  const offer = { instruction: 'hello', ...(mode === 'resume' ? { sessionRef: 'fake-thread-1' } : {}) };
  describe(`Codex plugin startup policy: ${mode}`, () => {
    it.each([
      ['excluded', 'writer', true],
      ['excluded', 'reader', true],
      [undefined, 'writer', false],
      ['inherit', 'writer', false],
      ['excluded', 'non-agent', false],
    ] as const)('policy=%s scope=%s excludes at spawn=%s', async (policy, scope, excluded) => {
      const { adapter, resources, launches, frames } = await setup(policy, scope);
      const session = await startPreparedOperation(adapter, offer, resources);
      sessions.push(session);
      for await (const event of session.events) {
        if (event.type === 'turn_end') break;
      }
      expect(launches).toHaveLength(1);
      const args = launches[0]!;
      const overrides = args.flatMap((arg, index) => arg === '-c' ? [args[index + 1]] : []);
      expect(overrides.filter(value => value === 'features.plugins=false')).toHaveLength(excluded ? 1 : 0);
      expect(overrides.some(value => value?.startsWith('chatgpt_base_url='))).toBe(false);
      expect(overrides.includes('project_root_markers=[".byok"]')).toBe(scope === 'reader');
      const rpc = await frames();
      const openMethod = mode === 'fresh' ? 'thread/start' : 'thread/resume';
      expect(rpc.filter(frame => frame.id !== undefined).map(frame => frame.method)).toEqual(
        excluded
          ? ['initialize', 'config/read', openMethod, 'mcpServerStatus/list', 'turn/start']
          : ['initialize', openMethod, 'turn/start'],
      );
      if (excluded) expect(rpc.find(frame => frame.method === openMethod).params.config.features.plugins).toBe(false);
    });

    it('excluded still refuses a plugin reported active after opening, before prompting', async () => {
      const { adapter, resources, launches, frames } = await setup('excluded', 'writer', {
        FAKE_CODEX_STATUS_EXTRA: JSON.stringify([{ name: 'leak', pluginId: 'example@market', runtimeStatus: 'connected' }]),
      });
      await expect(startPreparedOperation(adapter, offer, resources)).rejects.toMatchObject({
        phase: 'start', category: 'authority', retry: 'non-retryable',
        message: expect.stringContaining('thread still runs MCP servers outside the task'),
      });
      expect(launches[0]).toContain('features.plugins=false');
      expect((await frames()).some(frame => frame.method === 'turn/start')).toBe(false);
    });
  });
}
