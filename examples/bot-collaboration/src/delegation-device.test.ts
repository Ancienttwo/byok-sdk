import { expect, it } from 'vitest';
import { enqueue, hash, type LedgerState } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { addTurn, stateOf } from './model';
import { applyDelegate, observeDevices, settleDelegations } from './delegation';

function setup() {
  const s: LedgerState = { version: 1, sequence: 0, scanSequence: 0, intents: {}, executions: {}, routines: {}, occurrences: {}, slots: {}, outbox: {},
    applied: {}, application: {}, scanWake: null };
  const state = stateOf(s.application);
  for (const id of ['a', 'b']) state.team.bots[id] = { id, name: id, role: 'Member', persona: '', model: 'default', mainBot: false,
    archived: false, revision: '1', readyRevision: '1', execution: template(id === 'a' ? 'local' : 'remote', id) };
  const turn = addTurn(state, { id: 'root', root: 'root', source: 'user', request: 'Ask b', botId: 'a', hop: 0, authority: 'owner' });
  const events: string[] = [], emit = (id: string) => { events.push(id); };
  applyDelegate(state, turn, 'task', { delegate: [{ to: 'b', request: 'Check' }] }, false, 0, emit, (_kind, work) => work());
  const d = state.delegations[hash(['task', 'delegate', 0])]!;
  const input = { key: d.id, source: 'bot' as const, execution: template('remote', 'b'), waitUntil: 300_000 };
  return { s, state, d, input, events, emit };
}

it('uses offline presence only after offer delivery; never alters frozen input, budget, deadline or generation', () => {
  const { s, state, d, input, events, emit } = setup(), offline = new Map([['remote', false]]);
  observeDevices(s, state, offline, emit); // Persona wait: no intent.
  expect(d.status).toBe('queued');
  const intent = enqueue(s, 'tenant', input), execution = s.executions[intent.taskId]!;
  observeDevices(s, state, offline, emit); // FIFO wait: no submit.
  expect(d.status).toBe('queued');
  intent.phase = 'inflight'; execution.submission = 'uncertain';
  observeDevices(s, state, offline, emit);
  expect(d.status).toBe('queued');
  execution.submission = 'delivered';
  execution.attempt = { taskId: intent.taskId, deviceId: 'remote', status: 'offered', updatedAt: new Date(0).toISOString() } as typeof execution.attempt;
  const frozen = structuredClone({ intent, execution, budgets: state.budgets, units: state.units });
  observeDevices(s, state, offline, emit); observeDevices(s, state, offline, emit);
  expect(d.status).toBe('waiting_device');
  expect(events).toHaveLength(2); // queued and one wait event; exact re-observation is a no-op.
  expect({ intent, execution, budgets: state.budgets, units: state.units }).toEqual(frozen);
  observeDevices(s, state, new Map(), emit); // Missing discovery is no new evidence.
  expect(d.status).toBe('waiting_device');
  observeDevices(s, state, new Map([['remote', true]]), emit);
  expect(d.status).toBe('queued');
  execution.started = true;
  settleDelegations(s, state, 1, emit);
  observeDevices(s, state, offline, emit);
  expect(d.status).toBe('running'); // Presence cannot override a claim.
});
