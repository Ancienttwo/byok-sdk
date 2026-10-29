import { mkdtemp, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentHomeManager } from '@byok-sdk/client';
import { hash } from '@byok-sdk/server/execution-core';
import { createBotPersonaProjection } from './persona';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function delivery(revision: string, persona: string, request: number) {
  const projection = { schemaVersion: 'bot-profile.v1', name: 'Bot', role: 'Member', persona, model: 'default' };
  return { requestId: `00000000-0000-4000-8000-${String(request).padStart(12, '0')}`,
    agentRef: { agentId: 'persona-bot', profileRevision: revision }, projectionHash: `sha256:${hash(projection)}`, projection };
}

it('writes the persona to AGENTS.md, repairs it on a same-revision replay and refuses a wrong digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'byok-k8-persona-'));
  roots.push(root);
  const manager = new AgentHomeManager({ hostStorageRoot: root, projection: createBotPersonaProjection() });
  const agents = join(await realpath(root), 'agents', 'persona-bot', 'AGENTS.md');

  await expect(manager.project(delivery('1', 'First persona', 1))).resolves.toBe('applied');
  expect(await readFile(agents, 'utf8')).toBe('First persona');
  await unlink(agents);
  await expect(manager.project(delivery('1', 'First persona', 2))).resolves.toBe('idempotent');
  expect(await readFile(agents, 'utf8')).toBe('First persona');

  const wrong = { ...delivery('2', 'Second persona', 3), projectionHash: `sha256:${'0'.repeat(64)}` };
  await expect(manager.project(wrong)).rejects.toThrow('Invalid Bot persona projection');
  expect(await readFile(agents, 'utf8')).toBe('First persona');
});
