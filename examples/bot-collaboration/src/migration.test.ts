import { hash } from '@byok-sdk/example-host-execution-core/canonical';
import type { Occurrence, Routine } from '@byok-sdk/example-host-execution-core';
import { describe, expect, it } from 'vitest';
import { sealSwitchExport, SwitchExportError, verifySwitchExport, type SwitchContent, type SwitchExport, type SwitchExportRefusal } from './migration';
import { stateOf, type CollaborationState } from './model';
import type { BotProfile, HomeOperation } from './team-model';

const bot = (id: string, deviceId: string, archived = false) =>
  ({ id, name: id, role: 'r', persona: 'p', model: 'm', mainBot: false, archived, revision: '1', readyRevision: '1', execution: { deviceId, agentId: 'main' } }) as unknown as BotProfile;
const home = (sequence: number, extra: Partial<HomeOperation> = {}) =>
  ({ sequence, botId: 'b1', request: {}, retries: [], status: 'pending', ...extra }) as unknown as HomeOperation;

const ROUTINE: Routine = {
  definition: { id: 'r1', version: 1, timeZone: 'UTC', rule: { every: 'day' }, waitMs: 0, lateAfterMs: 60_000, hostJob: { type: 'job', input: {} } },
  lifecycle: 'active', status: 'ok', next: null,
};
const OCCURRENCE: Occurrence = {
  key: 'o1', routineId: 'r1', definitionVersion: 1, trigger: { kind: 'scheduled', plannedAt: 900 }, wakeKey: 'w1', recordedAt: 900, nextAt: null, attempts: 0,
};

function content(edit: (state: CollaborationState) => void = () => {}): SwitchContent {
  const state = stateOf({});
  state.team.bots.b1 = bot('b1', 'd1');
  edit(state);
  return {
    version: 1, source: 'L', domain: 'tenant-1', devices: [{ deviceId: 'd2', frozenRevision: 1 }, { deviceId: 'd1', frozenRevision: 3 }], exportedAt: 1_000,
    collaboration: state,
    archived: [{ namespace: 'turns', id: 't2', body: { n: 2 }, expiresAt: 9_000 }, { namespace: 'commands', id: 'c1', body: { n: 1 } }],
    intents: [{ key: 'i2', source: 'user', taskId: hash(['i2', 1]), generation: 1, deviceId: 'd1', agentId: 'main', conclusion: 'succeeded', started: true },
      { key: 'i1', source: 'routine', taskId: hash(['i1', 1]), generation: 1, deviceId: 'd1', agentId: 'main', conclusion: 'cancelled', started: false, cancelReason: 'cancelled' }],
    routines: [{ id: 'r1', routine: ROUTINE }],
    occurrences: [OCCURRENCE],
    slots: [{ slot: hash('s1'), occurrenceKey: 'o1' }],
    outbox: [{ kind: 'projection', id: 'p1', value: { v: 1 } }, { kind: 'host-job', occurrenceKey: 'o1' }],
    tombstones: [{ kind: 'row', digest: hash('r'), expiresAt: 5_000 }, { kind: 'intent', digest: hash('i0') }],
  };
}
function refused(run: () => unknown, reason: SwitchExportRefusal) {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(SwitchExportError);
    expect((error as SwitchExportError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected a ${reason} refusal`);
}

describe('switch export format (#975)', () => {
  it('seals each section in identity order with a manifest that verifies, and leaves the content unchanged', () => {
    const input = content();
    const before = structuredClone(input);
    const sealed = sealSwitchExport(input);
    expect(input).toEqual(before);
    expect(sealed.devices.map(device => device.deviceId)).toEqual(['d1', 'd2']);
    expect(sealed.archived.map(row => row.id)).toEqual(['c1', 't2']);
    expect(sealed.intents.map(row => row.key)).toEqual(['i1', 'i2']);
    expect(sealed.outbox.map(row => row.kind)).toEqual(['host-job', 'projection']);
    expect(sealed.tombstones.map(row => row.kind)).toEqual(['intent', 'row']);
    expect(sealed.manifest.counts).toEqual({ collaboration: 1, archived: 2, intents: 2, routines: 1, occurrences: 1, slots: 1, outbox: 2, tombstones: 2 });
    expect(sealed.manifest.digests.archived).toBe(hash(sealed.archived));
    expect(verifySwitchExport(sealed)).toEqual(sealed.manifest);
    // A target's read-back is a JSON round trip of what it wrote: the digest does not depend on key order or row order.
    const readBack = JSON.parse(JSON.stringify({ ...sealed, intents: [...sealed.intents] })) as SwitchExport;
    expect(verifySwitchExport(readBack).digest).toBe(sealed.manifest.digest);
    const shuffled = content();
    shuffled.devices.reverse(); shuffled.archived.reverse(); shuffled.outbox.reverse(); shuffled.tombstones.reverse();
    expect(sealSwitchExport(shuffled).manifest.digest).toBe(sealed.manifest.digest);
  });

  it('refuses a document whose content or header no longer matches its manifest', () => {
    const sealed = sealSwitchExport(content());
    refused(() => verifySwitchExport({ ...sealed, archived: [{ ...sealed.archived[0]!, body: { n: 9 } }, sealed.archived[1]!] }), 'manifest');
    refused(() => verifySwitchExport({ ...sealed, exportedAt: 1_001 }), 'manifest');
    refused(() => verifySwitchExport({ ...sealed, devices: [{ deviceId: 'd1', frozenRevision: 4 }, sealed.devices[1]!] }), 'manifest');
    refused(() => verifySwitchExport({ ...sealed, outbox: sealed.outbox.slice(1) }), 'manifest');
  });

  it('refuses rows out of identity order and repeated identities', () => {
    const sealed = sealSwitchExport(content());
    refused(() => verifySwitchExport({ ...sealed, intents: [...sealed.intents].reverse() }), 'unsorted');
    refused(() => verifySwitchExport({ ...sealed, devices: [...sealed.devices].reverse() }), 'unsorted');
    const repeated = content();
    repeated.intents.push({ ...repeated.intents[0]! });
    refused(() => sealSwitchExport(repeated), 'duplicate');
    refused(() => sealSwitchExport({ ...content(), devices: [{ deviceId: 'd1', frozenRevision: 3 }, { deviceId: 'd1', frozenRevision: 3 }] }), 'duplicate');
  });

  it('refuses the source owner records and a live Bot whose device the export does not move', () => {
    refused(() => sealSwitchExport(content(state => { state.topology = {}; })), 'owner_record');
    refused(() => sealSwitchExport(content(state => { state.team.bots.b2 = bot('b2', 'd3'); })), 'device_missing');
    expect(() => sealSwitchExport(content(state => { state.team.bots.b2 = bot('b2', 'd3', true); }))).not.toThrow();
  });

  it('refuses open work: an open Turn, an open input batch, an intent without a conclusion, a card call in flight', () => {
    refused(() => sealSwitchExport(content(state => { state.turns.t1 = { id: 't1' } as CollaborationState['turns'][string]; })), 'open_work');
    expect(() => sealSwitchExport(content(state => { state.turns.t1 = { id: 't1', conclusion: 'answered' } as CollaborationState['turns'][string]; }))).not.toThrow();
    refused(() => sealSwitchExport(content(state => {
      state.inputBatches = { x: { id: 'x', botId: 'b1', key: 'k', inputIds: [], bytes: 0, openedAt: 0, sealAt: 1, state: 'open' } };
    })), 'open_work');
    const open = content();
    delete (open.intents[0] as { conclusion?: string }).conclusion;
    refused(() => sealSwitchExport(open), 'open_work');
    refused(() => sealSwitchExport(content(state => { state.cardCalls = { card1: true }; })), 'card_call');
  });

  it('moves an unsent pending Agent home write and refuses one that may have reached a device', () => {
    expect(() => sealSwitchExport(content(state => { state.team.homeOperations.push(home(1), home(2, { status: 'applied', sent: true })); }))).not.toThrow();
    refused(() => sealSwitchExport(content(state => { state.team.homeOperations.push(home(1, { sent: true })); })), 'home_sent');
    refused(() => sealSwitchExport(content(state => { state.team.homeOperations.push(home(1, { retryAt: 10 })); })), 'home_sent');
  });

  it('refuses malformed content', () => {
    const cases: Array<(value: SwitchContent) => void> = [
      value => { (value as { version: number }).version = 2; },
      value => { (value as { source: string }).source = 'K'; },
      value => { value.domain = ''; },
      value => { value.exportedAt = -1; },
      value => { value.devices = []; },
      value => { value.devices = [{ deviceId: 'd1', frozenRevision: 0 }]; },
      value => { (value.collaboration as { version: number }).version = 2; },
      value => { value.intents[0]!.taskId = 'not-a-digest'; },
      value => { value.tombstones[0]!.digest = 'short'; },
      value => { (value.tombstones[0] as { kind: string }).kind = 'other'; },
      value => { (value.outbox[1] as { kind: string }).kind = 'intent'; },
      value => { value.archived[0]!.expiresAt = 1.5; },
      value => { (value.intents[0] as { conclusion: string }).conclusion = 'done'; },
      value => { (value.collaboration.team as { bots: unknown }).bots = null; },
      value => { value.archived[0]!.body = { n: Number.NaN }; },
      value => { value.outbox[0] = { kind: 'projection', id: 'p1', value: { at: new Date(0) } as unknown as Record<string, number> }; },
      value => { (value.archived[1] as { expiresAt?: number }).expiresAt = undefined; },
      value => { value.routines[0]!.routine = {} as Routine; },
      value => { value.routines[0]!.routine = { ...ROUTINE, definition: { ...ROUTINE.definition, id: 'r2' } }; },
      value => { value.routines[0]!.routine = { ...ROUTINE, definition: { ...ROUTINE.definition, execution: {} } } as unknown as Routine; },
      value => { value.routines[0]!.routine = { ...ROUTINE, lifecycle: 'gone' } as unknown as Routine; },
      value => { const { wakeKey: _wakeKey, ...rest } = OCCURRENCE; value.occurrences[0] = rest as Occurrence; },
      value => { value.occurrences[0] = { ...OCCURRENCE, trigger: { kind: 'late', plannedAt: 900 } } as unknown as Occurrence; },
      value => { value.occurrences[0] = { ...OCCURRENCE, nextAt: -1 }; },
      value => { (value.collaboration.team as { homeOperations: unknown }).homeOperations = {}; },
      value => { (value.collaboration.team.bots.b1 as { execution: unknown }).execution = null; },
      value => { value.collaboration.turns.t1 = null as unknown as CollaborationState['turns'][string]; },
    ];
    for (const edit of cases) {
      const value = content();
      edit(value);
      refused(() => sealSwitchExport(value), 'invalid');
    }
  });
});
