import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import type { Session } from '../types';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const sessions: Session[] = [];
const dirs: string[] = [];
async function openTracked(...args: Parameters<typeof startPreparedOperation>): Promise<Session> {
  const session = await startPreparedOperation(...args);
  sessions.push(session);
  return session;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function setup(reader = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grok-persona-')));
  dirs.push(root);
  const home = path.join(root, 'agent');
  const cwd = reader ? path.join(home, '.byok', 'runs', 'adapter-unit-test') : home;
  await fs.mkdir(cwd, { recursive: true });
  const log = path.join(root, 'wire.jsonl');
  const env = { PATH: process.env.PATH, FAKE_ACP_LOG: log, GROK_HOME: path.join(root, 'isolated-grok') };
  const adapter = new GrokAdapter({ resolveBin: () => ({ command: fixture, source: 'path' }) });
  return { home, cwd, log, root, env, adapter, resources: { workspaceDir: cwd, env,
    ...(reader ? { reader: { canonicalHome: home } } : { agentHome: home }) } };
}
async function facts(log: string): Promise<Array<Record<string, any>>> {
  return (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

it.each([false, true])('routes canonical persona only to session/new rules, preserving cwd and trust (reader=%s)', async reader => {
  const fixture = await setup(reader);
  await fs.writeFile(path.join(fixture.root, 'AGENTS.md'), 'ancestor decoy');
  await fs.writeFile(path.join(fixture.home, 'AGENTS.md'), 'Begin with SYNTHETIC_PERSONA_MARKER');
  if (reader) await fs.writeFile(path.join(fixture.cwd, 'AGENTS.md'), 'reader decoy');
  const session = await openTracked(fixture.adapter, { instruction: 'hello' }, fixture.resources);
  const wire = await facts(fixture.log);
  const initialized = wire.find(fact => fact.kind === 'initialize')!;
  const opened = wire.find(fact => fact.kind === 'open')!;
  expect(initialized.params._meta).not.toHaveProperty('rules');
  expect(opened.method).toBe('session/new');
  expect(opened.params._meta).toEqual({ yoloMode: true, rules: 'Begin with SYNTHETIC_PERSONA_MARKER' });
  expect(opened.params.cwd).toBe(fixture.cwd);
  const started = wire.find(fact => fact.kind === 'start')!;
  expect(started.argv).toEqual(['agent', '--always-approve', '--no-leader', 'stdio']);
  expect(started.env).not.toHaveProperty('GROK_FOLDER_TRUST');
  expect(started.env.GROK_HOME).toBe(fixture.env.GROK_HOME);
  expect(opened.params._meta).not.toHaveProperty('systemPromptOverride');
});

it.each(['symlink', 'directory', 'oversize'])('refuses unsafe canonical persona before spawning (%s)', async kind => {
  const fixture = await setup();
  const persona = path.join(fixture.home, 'AGENTS.md');
  if (kind === 'symlink') { await fs.writeFile(path.join(fixture.root, 'outside'), 'not persona'); await fs.symlink(path.join(fixture.root, 'outside'), persona); }
  else if (kind === 'directory') await fs.mkdir(persona);
  else await fs.writeFile(persona, Buffer.alloc(65537, 120));
  await expect(openTracked(fixture.adapter, { instruction: 'hello' }, fixture.resources)).rejects.toMatchObject({ category: 'authority', retry: 'non-retryable' });
  await expect(fs.access(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses persona-bearing Agent resume explicitly, without opening a replacement session', async () => {
  const fixture = await setup();
  await fs.writeFile(path.join(fixture.home, 'AGENTS.md'), 'persona');
  await expect(openTracked(fixture.adapter, { instruction: 'hello', sessionRef: 'fake-grok-session' }, fixture.resources)).rejects.toMatchObject({
    category: 'authority', retry: 'non-retryable', message: expect.stringContaining('persona resume is not qualified'),
  });
  await expect(fs.access(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['missing', 'empty'])('keeps Agent resume without persona unchanged (%s)', async kind => {
  const fixture = await setup();
  if (kind === 'empty') await fs.writeFile(path.join(fixture.home, 'AGENTS.md'), '');
  const session = await openTracked(fixture.adapter, { instruction: 'hello', sessionRef: 'fake-grok-session' }, fixture.resources);
  expect((await facts(fixture.log)).find(fact => fact.kind === 'open')!.params._meta).toEqual({ yoloMode: true });
});

it('rejects writer cwd inconsistent with its sealed canonical home', async () => {
  const fixture = await setup();
  await expect(openTracked(fixture.adapter, { instruction: 'hello' }, { ...fixture.resources, workspaceDir: fixture.root })).rejects.toMatchObject({ category: 'authority', retry: 'non-retryable' });
  await expect(fs.access(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a resumed reader cwd outside the home run directories before spawning', async () => {
  const fixture = await setup(true);
  const outside = path.join(fixture.home, 'notes');
  await fs.mkdir(outside, { recursive: true });
  await expect(openTracked(fixture.adapter, { instruction: 'hello', sessionRef: 'fake-grok-session' }, { ...fixture.resources, workspaceDir: outside }))
    .rejects.toMatchObject({ category: 'authority', retry: 'non-retryable' });
  await expect(fs.access(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  ['a fresh reader in another Attempt run directory', false, (home: string) => path.join(home, '.byok', 'runs', 'other-task')],
  ['a nested run directory', true, (home: string) => path.join(home, '.byok', 'runs', 'first-task', 'nested')],
  ['an unnormalized path out of the run directories', true, (home: string) => `${home}/.byok/runs/../../notes`],
  ['the run directories root', true, (home: string) => path.join(home, '.byok', 'runs')],
  ['the canonical home', true, (home: string) => home],
] as const)('refuses %s as a reader cwd before spawning', async (_shape, resumed, cwdOf) => {
  const fixture = await setup(true);
  const cwd = cwdOf(fixture.home);
  await fs.mkdir(path.resolve(cwd), { recursive: true });
  await expect(openTracked(fixture.adapter, { instruction: 'hello', ...(resumed ? { sessionRef: 'fake-grok-session' } : {}) }, { ...fixture.resources, workspaceDir: cwd }))
    .rejects.toMatchObject({ category: 'authority', retry: 'non-retryable' });
  await expect(fs.access(fixture.log)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not read ordinary workspace AGENTS.md or change ordinary resume', async () => {
  const fixture = await setup();
  await fs.mkdir(path.join(fixture.cwd, 'AGENTS.md'));
  const session = await openTracked(fixture.adapter, { instruction: 'hello', sessionRef: 'fake-grok-session' }, { workspaceDir: fixture.cwd, env: fixture.env });
  const opened = (await facts(fixture.log)).find(fact => fact.kind === 'open')!;
  expect(opened.method).toBe('session/resume');
  expect(opened.params._meta).toEqual({ yoloMode: true });
});
