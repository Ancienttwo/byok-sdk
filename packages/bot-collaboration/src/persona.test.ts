import { mkdtemp, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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

it('writes additional files and calls both callbacks again on an exact replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'byok-k8-persona-')); roots.push(root);
  const home = join(await realpath(root), 'agents', 'persona-bot');
  const renderAdditionalFiles = vi.fn(({ projection }: { projection: { persona: string } }) => [
    { name: 'CLAUDE.md', body: projection.persona }, { name: 'profile.json', body: new TextEncoder().encode('{"ok":true}') },
  ]);
  const afterWrite = vi.fn(async (input: { canonicalHome: string }) => {
    expect(input.canonicalHome).toBe(home);
    expect(await readFile(join(home, 'CLAUDE.md'), 'utf8')).toBe('Persona');
    expect(await readFile(join(home, 'profile.json'), 'utf8')).toBe('{"ok":true}');
  });
  const manager = new AgentHomeManager({ hostStorageRoot: root, projection: createBotPersonaProjection({ renderAdditionalFiles, afterWrite }) });
  const first = delivery('1', 'Persona', 1);
  expect(await manager.project(first)).toBe('applied');
  expect(await manager.project(delivery('1', 'Persona', 2))).toBe('idempotent');
  expect(renderAdditionalFiles).toHaveBeenCalledTimes(2);
  expect(afterWrite).toHaveBeenCalledTimes(2);
  expect(afterWrite.mock.calls[0]![0]).toMatchObject({ agentRef: first.agentRef, requestId: first.requestId,
    projectionHash: first.projectionHash, projection: first.projection });
});

it('refuses an additional AGENTS.md before writing the persona', async () => {
  const root = await mkdtemp(join(tmpdir(), 'byok-k8-persona-')); roots.push(root);
  const manager = new AgentHomeManager({ hostStorageRoot: root, projection: createBotPersonaProjection({
    renderAdditionalFiles: () => [{ name: 'agents.md', body: 'wrong' }],
  }) });
  await expect(manager.project(delivery('1', 'Persona', 1))).rejects.toThrow('AGENTS.md is reserved');
  await expect(readFile(join(root, 'agents', 'persona-bot', 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['render', 'afterWrite'] as const)('does not record projection state when %s fails', async phase => {
  const root = await mkdtemp(join(tmpdir(), 'byok-k8-persona-')); roots.push(root);
  let fail = true;
  const check = () => { if (fail) throw new Error('callback failed'); };
  const manager = new AgentHomeManager({ hostStorageRoot: root, projection: createBotPersonaProjection({
    renderAdditionalFiles: () => { if (phase === 'render') check(); return []; },
    afterWrite: () => { if (phase === 'afterWrite') check(); },
  }) });
  await expect(manager.project(delivery('1', 'Persona', 1))).rejects.toThrow('callback failed');
  fail = false;
  expect(await manager.project(delivery('1', 'Persona', 2))).toBe('applied');
});
