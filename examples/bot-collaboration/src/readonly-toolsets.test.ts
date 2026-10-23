import { afterEach, expect, it, vi } from 'vitest';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration } from './host';

let fixture: TestHost | undefined;
let bot: BotCollaboration | undefined;
afterEach(async () => { await bot?.close(); bot = undefined; await fixture?.close(); fixture = undefined; });
it('allows a Host-declared read-only toolset on a chat turn and owns its policy/template snapshot', async () => {
  fixture = await openHost({ ledgerOptions: { compactVeto: botCompactVeto } });
  const execution = template(fixture.deviceId);
  execution.payload.requiredToolsets = ['market.read'];
  const policy = ['market.read'];
  bot = new BotCollaboration(fixture.server, fixture.ledger, { botId: 'main', execution,
    readOnlyToolsets: policy, connector: async () => ({}) });
  policy.push('market.trade');
  execution.payload.requiredToolsets.push('market.trade');
  const id = await bot.input('market', 'Read market quotes');
  expect(bot.core.intent(id)?.execution.payload.requiredToolsets).toEqual(['market.read']);
});

it('rejects undeclared toolsets in model templates and persisted Bot executions', async () => {
  fixture = await openHost({ ledgerOptions: { compactVeto: botCompactVeto } });
  const execution = template(fixture.deviceId);
  const unsafe = structuredClone(execution); unsafe.payload.requiredToolsets = ['market.trade'];
  const options = { botId: 'main', execution, connector: async () => ({}), readOnlyToolsets: ['market.read'] };
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, { ...options, models: { unsafe } })).toThrow('not declared read-only');
  bot = new BotCollaboration(fixture.server, fixture.ledger, options);
  await bot.close(); bot = undefined;
  fixture.ledger.transaction(s => { stateOf(s.application).team.bots.main!.execution = unsafe; });
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, options)).toThrow('not declared read-only');
});

import { createBot, updateBot } from './team';
import { stateOf } from './model';
import { ownReadOnlyToolsets } from './toolset-policy';
import { botCompactVeto } from './compaction';
it('shares default-deny admission across create and update without changing state on refusal', () => {
  const execution = template('device'); execution.payload.requiredToolsets = ['market.read'];
  const models = { quotes: execution };
  const action = { localId: 'new_bot_1', name: 'Reader', role: 'Research', persona: 'Read only', model: 'quotes' };
  const state = stateOf({});
  expect(() => createBot(state, 'task', action, models)).toThrow('not declared read-only');
  expect(Object.keys(state.team.bots)).toHaveLength(0);
  const created = createBot(state, 'task', action, models, ['market.read']);
  expect(created.execution.payload.requiredToolsets).toEqual(['market.read']);
  const revision = created.revision;
  expect(() => updateBot(state, { botId: created.id, name: 'Changed' }, models)).toThrow('not declared read-only');
  expect(created.revision).toBe(revision);
  updateBot(state, { botId: created.id, name: 'Changed' }, models, ['market.read']);
  expect(created.name).toBe('Changed');
  expect(created.execution.payload.requiredToolsets).toEqual(['market.read']);
  expect(() => ownReadOnlyToolsets(['market.read', 'market.read'])).toThrow();
  expect(() => ownReadOnlyToolsets(['../unsafe'])).toThrow();
});

it('rejects malformed JavaScript allowlists instead of iterating strings', () => {
  for (const value of ['ab', null, {}, new Set(['market.read'])]) {
    expect(() => ownReadOnlyToolsets(value as unknown as readonly string[])).toThrow('must be an array');
  }
});


it('refuses recovery of outstanding frozen toolsets after the Bot changes models, but keeps settled history readable', async () => {
  fixture = await openHost({ ledgerOptions: { compactVeto: botCompactVeto } });
  await fixture.offline();
  const execution = template(fixture.deviceId);
  execution.payload.requiredToolsets = ['market.read'];
  bot = new BotCollaboration(fixture.server, fixture.ledger, { botId: 'main', execution, readOnlyToolsets: ['market.read'], connector: async () => ({}) });
  const id = await bot.input('frozen', 'Read quotes');
  const taskId = bot.core.intent(id)!.taskId;
  await bot.close(); bot = undefined;
  const safe = template(fixture.deviceId);
  fixture.ledger.transaction(s => { stateOf(s.application).team.bots.main!.execution = safe; });
  const submit = vi.spyOn(fixture.server.executions, 'submit');
  const options = { botId: 'main', execution: safe, connector: async () => ({}) };
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, options)).toThrow('not declared read-only');
  expect(submit).not.toHaveBeenCalled();
  // A frozen execution input must also be checked independently of its intent template.
  fixture.ledger.transaction(s => {
    const intent = Object.values(s.intents).find(i => i.key === id)!;
    intent.execution = safe;
    s.executions[taskId] = { input: { ...execution, taskId }, submission: 'reserved', started: false };
  });
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, options)).toThrow('not declared read-only');
  expect(submit).not.toHaveBeenCalled();
  fixture.ledger.transaction(s => { Object.values(s.intents).find(i => i.key === id)!.conclusion = 'cancelled'; });
  bot = new BotCollaboration(fixture.server, fixture.ledger, options);
  expect(bot.snapshot().team.bots.main!.execution.payload.requiredToolsets).toBeUndefined();
  // The settled execution record stays readable and keeps its original toolset.
  expect(bot.core.intent(id)?.conclusion).toBe('cancelled');
  expect(fixture.ledger.snapshot().executions[taskId]?.input.payload.requiredToolsets).toEqual(['market.read']);
  submit.mockRestore();
});

it('refuses an initial template with required toolsets when the Host declares no allowlist', async () => {
  fixture = await openHost({ ledgerOptions: { compactVeto: botCompactVeto } });
  const execution = template(fixture.deviceId);
  execution.payload.requiredToolsets = ['market.read'];
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, { botId: 'main', execution, connector: async () => ({}) }))
    .toThrow('not declared read-only');
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, { botId: 'main', execution, readOnlyToolsets: [], connector: async () => ({}) }))
    .toThrow('not declared read-only');
});

it('checks only non-archived Bot templates on reopen', async () => {
  fixture = await openHost({ ledgerOptions: { compactVeto: botCompactVeto } });
  const options = { botId: 'main', execution: template(fixture.deviceId), connector: async () => ({}), readOnlyToolsets: ['market.read'] };
  bot = new BotCollaboration(fixture.server, fixture.ledger, options);
  const main = bot.snapshot().team.bots.main!;
  await bot.close(); bot = undefined;
  const retired = structuredClone(main);
  retired.id = 'retired'; retired.mainBot = false; retired.archived = true;
  retired.execution.payload.agentRef = { agentId: 'retired', profileRevision: retired.revision };
  retired.execution.payload.requiredToolsets = ['market.trade'];
  fixture.ledger.transaction(s => { stateOf(s.application).team.bots.retired = retired; });
  bot = new BotCollaboration(fixture.server, fixture.ledger, options);
  expect(bot.snapshot().team.bots.retired!.archived).toBe(true);
  await bot.close(); bot = undefined;
  fixture.ledger.transaction(s => { stateOf(s.application).team.bots.retired!.archived = false; });
  expect(() => new BotCollaboration(fixture!.server, fixture!.ledger, options)).toThrow('not declared read-only');
});
