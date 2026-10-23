import { canonical, type Json } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { admitUserInput } from '@byok-sdk/example-bot-collaboration/coalesce';
import { stateOf, type CollaborationState } from '@byok-sdk/example-bot-collaboration/model';
import { commitCommand, type CommandPorts } from '@byok-sdk/example-bot-collaboration/rules/commands';
import { writeSnapshotBot } from '@byok-sdk/example-bot-collaboration/team';
import { seedCollaboration, VECTOR_NOW, type CommitSubject, type SeedTeam } from '@byok-sdk/example-bot-collaboration/test-support';

/** The test ports of a commit: the vector clock, the Host input admission and the snapshot Bot template. */
export function vectorPorts(state: CollaborationState, publish: CommandPorts['publish']): CommandPorts {
  return { now: () => VECTOR_NOW, publish, admitInput: fields => admitUserInput(state, fields, undefined, VECTOR_NOW),
    teamBot: row => writeSnapshotBot(state, row, { default: template('device', 'main') }),
    outcome: { committed: { intent: () => undefined }, manage: () => {}, createRoutine: () => {}, updateRoutine: () => {}, cancelRoutine: () => {} } };
}
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
      const result = commitCommand(next.state, request, { scope: 'memory', recordCallbacks: true }, vectorPorts(next.state, (id, value) => {
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
