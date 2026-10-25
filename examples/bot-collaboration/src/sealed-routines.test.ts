import { describe, expect, it, beforeAll } from 'vitest';
import { hash, promoteOccurrence, recordOccurrence, routineCommands, routineTemplateBinding, sealRoutineTemplate, type LedgerState,
  type Routine } from '@byok-sdk/example-host-execution-core';
import { sealContent } from '@byok-sdk/core/sealed-payload';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { BOT_ROUTINE, botRoutines, resealDefinition, routineCalendar, routineTurn, sealedDefinition, sealedRoutineInstruction, sealedTemplate,
  SealedRoutineVersionError, updateDefinition, type SealedRoutineAction, type SealedRoutineTemplate } from './routines';
import { SYSTEM_PROMPT } from './rules/schema';
import { syncTurn } from './rules/sync';
import { stateOf } from './model';

const execution = template('device-1');
const sealing = { scopeId: 'scope-1', epoch: 1, categories: ['task-input' as const] };
const notAfter = '2099-01-01T00:00:00.000Z';
const schedule = { minute: 0, hour: 9, tz: 'UTC' };
const scopeKey = Uint8Array.from({ length: 32 }, (_, index) => index);

async function sealed(routineId: string, definitionVersion: number, prompt = 'Check the watchlist.'): Promise<SealedRoutineTemplate> {
  const agentRef = execution.payload.agentRef;
  const template = await sealRoutineTemplate({ tenantId: 'product:p', scopeKey, sealing, chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
    sender: 'A'.repeat(43), routineRef: { routineId, definitionVersion, notAfter }, agentRef, instruction: sealedRoutineInstruction(prompt) });
  return { sealing, template, agentRef: { agentId: agentRef.agentId, profileRevision: agentRef.profileRevision }, notAfter };
}
function ledger() {
  const state: LedgerState = { version: 1, sequence: 0, scanSequence: 0, intents: {}, executions: {}, routines: {}, occurrences: {}, slots: {},
    outbox: {}, applied: {}, application: {}, scanWake: null };
  return { state, commands: routineCommands(state, { now: () => Date.parse('2026-10-26T00:00:00.000Z'), nextTime: routineCalendar, hostJobs: new Map(),
    occurrenceHooks: new Map([[BOT_ROUTINE, routineTurn as never]]) }) };
}

describe('sealed Bot routines (#953)', () => {
  let v1: SealedRoutineTemplate, v2: SealedRoutineTemplate;
  beforeAll(async () => { v1 = await sealed('r-1', 1); v2 = await sealed('r-1', 2, 'Check it again.'); });
  const action = (definitionVersion: number, template: SealedRoutineTemplate): SealedRoutineAction =>
    ({ routineId: 'r-1', definitionVersion, schedule, sealed: template });

  it('creates version 1 with owner authority, and its view and ContextPack row carry no template', () => {
    const { commands } = ledger();
    commands.create(sealedDefinition(commands.list(), 'main', action(1, v1), execution));
    const [routine] = commands.list();
    expect(routine!.definition.hostOccurrence!.input).toMatchObject({ owner: 'main', authority: 'owner', sealed: { notAfter } });
    const [view] = botRoutines(commands.list());
    expect(view!.definition).toEqual({ version: 1, schedule, sealed: true, target: 'main' });
    expect(JSON.stringify(view)).not.toContain(v1.template.contentMac);
    expect(sealedTemplate(commands.list(), { routineId: 'r-1', definitionVersion: 1 })).toEqual(v1);
    expect(sealedTemplate(commands.list(), { routineId: 'r-1', definitionVersion: 2 })).toBeUndefined();
  });

  it('refuses an id that exists, another version, another Agent, other categories and the ninth open routine', async () => {
    const { commands } = ledger();
    commands.create(sealedDefinition(commands.list(), 'main', action(1, v1), execution));
    expect(() => sealedDefinition(commands.list(), 'main', { ...action(1, v1), schedule: { ...schedule, hour: 10 } }, execution)).toThrow('already has this id');
    expect(() => sealedDefinition(commands.list(), 'main', action(1, v2), execution)).toThrow('already has this id');
    expect(() => sealedDefinition(commands.list(), 'helper', action(1, v1), execution)).toThrow('already has this id');
    // An exact retry after a lost response is the same definition, which K4 takes as a no-op.
    const replay = sealedDefinition(commands.list(), 'main', action(1, v1), execution);
    expect(replay).toEqual(commands.list()[0]!.definition);
    commands.create(replay);
    expect(commands.list()).toHaveLength(1);
    expect(() => sealedDefinition([], 'main', action(2, v1), execution)).toThrow(SealedRoutineVersionError);
    const otherAgent = { ...execution, payload: { ...execution.payload, agentRef: { agentId: 'main', profileRevision: '2' } } };
    expect(() => sealedDefinition([], 'main', action(1, v1), otherAgent)).toThrow('another Agent revision');
    const both = { ...v1, sealing: { ...sealing, categories: ['task-input', 'task-output'] as const } } as unknown as SealedRoutineTemplate;
    expect(() => sealedDefinition([], 'main', action(1, both), execution)).toThrow('task-input only');
    const full = ledger();
    for (let index = 0; index < 8; index++) {
      full.commands.create(sealedDefinition(full.commands.list(), 'main', { ...action(1, await sealed(`r-${index + 10}`, 1)), routineId: `r-${index + 10}` },
        execution));
    }
    expect(() => sealedDefinition(full.commands.list(), 'main', action(1, v1), execution)).toThrow('Routine limit is 8');
  });

  it('reseals only a sealed routine at the next version, keeps owner and authority, and replays a staged reseal', () => {
    const { commands } = ledger();
    commands.create(sealedDefinition(commands.list(), 'main', action(1, v1), execution));
    expect(() => resealDefinition(commands.list(), 'main', action(3, v2), execution)).toThrow(SealedRoutineVersionError);
    const next = resealDefinition(commands.list(), 'main', action(2, v2), execution);
    commands.update(next);
    // No occurrence is open, so K4 switches to the new version in the update commit.
    expect(commands.list()[0]!.definition).toEqual(next);
    expect(next.hostOccurrence!.input).toMatchObject({ owner: 'main', authority: 'owner' });
    // A member retry of the same reseal is the same definition, which K4 takes as a no-op.
    commands.update(resealDefinition(commands.list(), 'main', action(2, v2), execution));
    expect(() => resealDefinition(commands.list(), 'main', action(2, v1), execution)).toThrow(SealedRoutineVersionError);
  });

  it('refuses a template that travels by ciphertextRef: between occurrences no task holds its blob', async () => {
    const agentRef = { agentId: execution.payload.agentRef.agentId, profileRevision: execution.payload.agentRef.profileRevision };
    // A real seal above the inline limit, so the header is valid and only the inline check refuses it.
    const large = await sealContent({ scopeKey, scope: { id: sealing.scopeId, epoch: sealing.epoch }, chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
      sender: 'A'.repeat(43), category: 'task-input', plaintext: { instruction: 'x'.repeat(300 * 1024) }, maxContentLength: 2 * 1024 * 1024,
      binding: routineTemplateBinding('product:p', { routineId: 'r-1', definitionVersion: 1, notAfter }, agentRef, sealing.categories) });
    const byReference = { ...v1, template: { ...large.header, ciphertextRef: { blobId: 'blob-1', contentHash: `sha256:${'b'.repeat(64)}`,
      size: large.ciphertext.byteLength, contentType: 'application/octet-stream' } } } as unknown as SealedRoutineTemplate;
    expect(() => sealedDefinition([], 'main', action(1, byReference), execution)).toThrow('A sealed routine template must be inline');
  });

  it('checks a reseal as a create: another Agent revision or another category list is refused', () => {
    const { commands } = ledger();
    commands.create(sealedDefinition(commands.list(), 'main', action(1, v1), execution));
    const otherAgent = { ...execution, payload: { ...execution.payload, agentRef: { agentId: 'main', profileRevision: '2' } } };
    expect(() => resealDefinition(commands.list(), 'main', action(2, v2), otherAgent)).toThrow('another Agent revision');
    const both = { ...v2, sealing: { ...sealing, categories: ['task-input', 'task-output'] as const } } as unknown as SealedRoutineTemplate;
    expect(() => resealDefinition(commands.list(), 'main', action(2, both), execution)).toThrow('task-input only');
  });

  it('never turns a sealed routine plain, and never seals a plain one', () => {
    const { commands } = ledger();
    commands.create(sealedDefinition(commands.list(), 'main', action(1, v1), execution));
    expect(() => updateDefinition(commands.list(), 'main', { routineId: 'r-1', prompt: 'plain now' })).toThrow('only through resealRoutine');
    expect(() => updateDefinition(commands.list(), 'main', { routineId: 'r-1', schedule })).toThrow('only through resealRoutine');
    const plain = ledger();
    plain.commands.create({ id: 'r-1', version: 1, timeZone: 'UTC', rule: schedule, waitMs: 300_000, lateAfterMs: 60_000,
      hostOccurrence: { type: BOT_ROUTINE, input: { owner: 'main', authority: 'bot', prompt: 'plain' } } } as never);
    expect(() => resealDefinition(plain.commands.list() as Routine[], 'main', action(2, v2), execution)).toThrow('Only a sealed routine');
  });

  it('writes an occurrence Turn with no request, and freezes it into a K4 occurrence intent that carries the template', () => {
    const { state, commands } = ledger();
    commands.create(sealedDefinition(commands.list(), 'main', action(1, v1), execution));
    const next = state.routines[hash('r-1')]!.next!;
    const occurrence = recordOccurrence(state, 'product:p', { wakeId: 'w', dedupKey: next.dedupKey, availableAt: next.availableAt,
      deliveredAt: next.availableAt, delivery: 1 }, next.availableAt, routineCalendar)!;
    const collaboration = stateOf(state.application);
    collaboration.team.bots.main = { id: 'main', name: 'Main', role: 'Owner', persona: '', model: 'default', mainBot: true, archived: false,
      revision: '1', readyRevision: '1', execution };
    routineTurn(collaboration, { type: BOT_ROUTINE, input: commands.list()[0]!.definition.hostOccurrence!.input, occurrenceKey: occurrence.key,
      routineId: 'r-1', definitionVersion: 1, trigger: occurrence.trigger });
    const turn = collaboration.turns[`occurrence:${occurrence.key}`]!;
    expect(turn).toMatchObject({ source: 'routine', request: '', authority: 'owner', sealedRoutine: { routineId: 'r-1', definitionVersion: 1 } });
    const step = syncTurn(collaboration, turn, { intent: () => undefined, executionStarted: () => false, retired: () => undefined },
      { now: 0, models: ['default'], readOnlyToolsets: [], limits: { turnLimit: 12, contextMaxBytes: 32_768, instructionMaxBytes: 65_536 },
        historyMode: false, routines: botRoutines(commands.list()), sealedTemplate: ref => sealedTemplate(commands.list(), ref) }, () => {});
    if (step?.kind !== 'routine') throw new Error('The sealed Turn did not freeze');
    const intent = promoteOccurrence(state, 'product:p', occurrence.key, step.execution);
    expect(intent.execution.payload).not.toHaveProperty('instruction');
    expect(intent.execution.payload).toMatchObject({ sealing, sealed: v1.template, routineRef: { routineId: 'r-1', definitionVersion: 1, notAfter } });
  });

  it('seals the K8 Turn frame with every action and no ContextPack', () => {
    const instruction = sealedRoutineInstruction('Check the watchlist.');
    expect(instruction).toBe(`${SYSTEM_PROMPT}\n\nRequest:\nCheck the watchlist.`);
    expect(instruction).not.toContain('\n\nContextPack:\n');
  });
});
