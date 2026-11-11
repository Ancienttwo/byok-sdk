import { canonical, type Json, type RoutineCommands } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { admitUserInput, botOutcomePorts, type CollaborationState, type CommandPorts, stateOf, writeSnapshotBot } from '@byok-sdk/bot-collaboration/host-kit';
import { commitCommand } from '@byok-sdk/bot-collaboration/rules';
import { type CommitSubject, seedCollaboration, type SeedTeam, VECTOR_NOW } from '@byok-sdk/bot-collaboration/testing';
import type { HostConfig } from './store';

/** The Host config of every test scope: the snapshot Bot template of the K8 vector subject (K8 commit-contract.test.ts). */
export const testHostConfig = (): HostConfig => ({ models: { default: template('device', 'main') }, readOnlyToolsets: [], dreaming: false });
/** The store's `host` option for tests: every scope gets `testHostConfig()`. */
export const TEST_HOST = async (): Promise<HostConfig> => testHostConfig();
/** The vector clock, as the Host clock of a commit or a terminal transaction. */
export const vectorClock = (): number => VECTOR_NOW;
/**
 * The ports of the memory subject: the vector clock, the snapshot Bot template, the input admission with no coalescing and
 * the outcome ports of a callback command, with a team management port that does nothing.
 */
export function callbackPorts(state: CollaborationState, publish: CommandPorts['publish'], taskId: string | undefined): CommandPorts {
  return { now: vectorClock, publish, teamBot: row => writeSnapshotBot(state, row, testHostConfig().models),
    admitInput: fields => admitUserInput(state, fields, undefined, VECTOR_NOW),
    ...(taskId === undefined ? {} : { outcome: { committed: { intent: () => undefined },
      ...botOutcomePorts({ taskId, routines: VECTOR_ROUTINES, manage: () => {}, roomPosts: false }) } }) };
}
/** The routine store of the K8 commit vectors: validates routine actions without persisting them. */
export const VECTOR_ROUTINES: RoutineCommands = { create: () => {}, update: () => {}, lifecycle: () => {}, list: () => [] };
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
      const result = commitCommand(next.state, request, { scope: 'memory', recordCallbacks: true,
        // No retention here: nothing is archived or retired.
        archived: () => undefined, admitted: () => {} }, callbackPorts(next.state, (id, value) => {
        if (next.outbox[id] !== undefined && canonical(next.outbox[id]) !== canonical(value)) throw new Error('Projection identity conflict');
        next.outbox[id] = value;
      }, request.command.kind === 'outcome' ? request.command.taskId : undefined));
      stored = next;
      return result;
    },
    stored: () => JSON.stringify(stored),
    state: () => structuredClone(stored.state),
  };
}
