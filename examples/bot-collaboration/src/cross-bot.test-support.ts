import { expect, vi } from 'vitest';
import { hash, type Json } from '@byok-sdk/server/execution-core';
import type { TestTeam } from './team.test-support';
import type { Delegation } from './model';

/** Helpers over the real embedded server, daemon and submit_result helper. */
export function crossBot(fixture: () => TestTeam) {
  const host = () => fixture().host;
  const taskOf = (id: string) => host().core.intent(id)!.taskId;
  async function running(id: string) {
    await vi.waitFor(async () => { await host().drain(); expect(fixture().adapter.sessions.has(host().core.intent(id)?.taskId ?? '')).toBe(true); }, { timeout: 5000 });
    return fixture().adapter.sessions.get(taskOf(id))!;
  }
  async function finish(id: string, document: unknown = {}) {
    (await running(id)).finish(document);
    await vi.waitFor(async () => { await host().drain(); expect(host().snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
  }
  async function createBots(count: number) {
    const id = await host().input('create-bots', 'Create the team');
    await finish(id, { create_bot: Array.from({ length: count }, (_, i) => ({ localId: `new_bot_${i + 1}`, name: `Bot ${i + 1}`,
      role: 'Reviewer', persona: `Persona ${i + 1}`, model: 'default' })) });
    const bots = Object.values(host().snapshot().team.bots).filter(b => b.id !== 'main').map(b => b.id);
    await vi.waitFor(async () => {
      await host().drain();
      for (const bot of bots) expect(host().snapshot().team.bots[bot]!.readyRevision).toBe(host().snapshot().team.bots[bot]!.revision);
    }, { timeout: 5000 });
    return bots;
  }
  const delegation = (id: string): Delegation => host().snapshot().delegations[id]!;
  const delegationOf = (taskId: string, index = 0): Delegation => delegation(hash([taskId, 'delegate', index]));
  const instruction = (id: string) => String(fixture().ledger.snapshot().executions[taskOf(id)]!.input.payload.instruction);
  const context = (id: string) => JSON.parse(instruction(id).split('\n\nContextPack:\n')[1]!);
  /** Every delegation event in the K4 outbox, in commit order. */
  const events = (id: string) => Object.values(fixture().ledger.snapshot().outbox)
    .filter(row => row.kind === 'projection' && row.id.startsWith(`delegation:${id}:`))
    .map(row => (row as { value: Json }).value as unknown as Pick<Delegation, 'revision' | 'status' | 'verdict' | 'reason' | 'replyTurnId'>);
  return { host, taskOf, running, finish, createBots, delegation, delegationOf, instruction, context, events };
}
