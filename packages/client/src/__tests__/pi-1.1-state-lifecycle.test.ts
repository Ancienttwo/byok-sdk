import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { mapPiMessageToAgentEvent } from '../adapters/pi/events';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { startPreparedOperation } from './fixtures/prepared-operation';
import type { Session } from '../types';

const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function start(instruction: string) {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'byok-pi-state-')); roots.push(workspaceDir);
  const adapter = new PiAdapter({ resolveBin: () => ({ command: path.resolve(import.meta.dirname, 'fixtures/fake-pi.mjs'), source: 'package' }) });
  const session = await startPreparedOperation(adapter, { instruction }, { workspaceDir, env: process.env });
  sessions.push(session); return session;
}
describe('Pi 1.1 settlement control', () => {
  it('uses whole-agent settlement, including native abort, rather than low-level turn/run endings', () => {
    expect(mapPiMessageToAgentEvent({ type: 'turn_end' })).toBeUndefined();
    expect(mapPiMessageToAgentEvent({ type: 'agent_end' })).toBeUndefined();
    expect(mapPiMessageToAgentEvent({ type: 'agent_settled', aborted: false })).toEqual({ type: 'turn_end' });
    expect(() => mapPiMessageToAgentEvent({ type: 'agent_settled', aborted: true })).toThrow('pi run aborted before completion');
  });
  it('delivers final context usage before normal completion', async () => {
    const session = await start('fake normal completion'); const types: string[] = [];
    for await (const event of session.events) { types.push(event.type); if (event.type === 'turn_end') break; }
    expect(types.slice(-2)).toEqual(['usage', 'turn_end']);
    expect(types.filter(type => type === 'turn_end')).toHaveLength(1);
  });
  it('delivers final usage then rejects native abort without publishing success', async () => {
    const session = await start('fake native abort'); const types: string[] = [];
    let failure: unknown;
    try { for await (const event of session.events) types.push(event.type); } catch (error) { failure = error; }
    expect(types.at(-1)).toBe('usage');
    expect(types).not.toContain('turn_end');
    expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
    expect(failure).toMatchObject({ category: 'semantic', retry: 'non-retryable', message: 'pi run aborted before completion' });
  });
  it('acknowledges requested interruption after native aborted settlement', async () => {
    const session = await start('fake normal completion');
    await expect(session.interrupt()).resolves.toBeUndefined();
  });
});
