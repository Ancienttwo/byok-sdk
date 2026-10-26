import { canonical, type Json } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { admitUserInput } from '@byok-sdk/example-bot-collaboration/coalesce';
import { stateOf, type CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { commitCommand, type CommandPorts } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { writeSnapshotBot } from '@byok-sdk/example-bot-collaboration/team';
import { seedCollaboration, VECTOR_NOW, type CommitSubject, type SeedTeam } from '@byok-sdk/example-bot-collaboration/test-support';
import type { HostConfig, OutcomeRoutinePorts } from './store';

/** The Host config of every test scope: the snapshot Bot template of the K8 vector subject (K8 commit-contract.test.ts). */
export const testHostConfig = (): HostConfig => ({ models: { default: template('device', 'main') }, readOnlyToolsets: [] });
/** The store's `host` option for tests: every scope gets `testHostConfig()`. */
export const TEST_HOST = async (): Promise<HostConfig> => testHostConfig();
/** The vector clock, as the Host clock of a commit or a terminal transaction. */
export const vectorClock = (): number => VECTOR_NOW;
/**
 * The ports of the memory subject: the vector clock, the snapshot Bot template, the input admission with no coalescing and
 * the outcome ports of a callback command, with a team management port that does nothing.
 */
export function callbackPorts(state: CollaborationState, publish: CommandPorts['publish']): CommandPorts {
  return { now: vectorClock, publish, teamBot: row => writeSnapshotBot(state, row, testHostConfig().models),
    admitInput: fields => admitUserInput(state, fields, undefined, VECTOR_NOW),
    outcome: { committed: { intent: () => undefined }, manage: () => {}, ...VECTOR_ROUTINES } };
}
/** The outcome routine ports of the K8 commit vectors, which run no routine action. */
export const VECTOR_ROUTINES: OutcomeRoutinePorts = { createRoutine: () => {}, updateRoutine: () => {}, cancelRoutine: () => {} };
/**
 * The reference subject for H: the pure rules on a plain object, with callback records as in H.
 * A commit works on a copy and keeps it only when it returns.
 */
export function memorySubject(team?: SeedTeam): CommitSubject {
  let stored = { state: stateOf({}), outbox: {} as Record<string, Json> };
  seedCollaboration(stored.state, team);
  return {
    scope: 'memory',
    commit(request) {
      const next = structuredClone(stored);
      const result = commitCommand(next.state, request, { scope: 'memory', recordCallbacks: true }, callbackPorts(next.state, (id, value) => {
        if (next.outbox[id] !== undefined && canonical(next.outbox[id]) !== canonical(value)) throw new Error('Projection identity conflict');
        next.outbox[id] = value;
      }));
      stored = next;
      return result;
    },
    stored: () => JSON.stringify(stored),
    state: () => structuredClone(stored.state),
  };
}
