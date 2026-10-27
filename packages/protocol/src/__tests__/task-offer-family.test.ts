import { describe, expect, it } from 'vitest';
import { DAEMON_TO_SERVER_TYPES, EnvelopeSchema, MESSAGE_TYPES, SERVER_TO_DAEMON_TYPES } from '../index';

/** The wire v4 message types (#925 stage 2 design, Q1), grouped by direction. */
const V4_TYPES = {
  hello: ['conn.hello'],
  serverToDaemon: [
    'task.offer', 'agent.egress.ack', 'agent.message.disposition', 'agent.content.read', 'agent.home.projection',
    'agent.input.preparation', 'provider.provisioning.available', 'agent.memory.intent.available', 'task.approve',
    'task.reject', 'task.cancel', 'task.steer', 'e2ee.key_package.available',
  ],
  daemonToServer: [
    'task.claim', 'task.started', 'task.decline', 'task.progress', 'task.artifact', 'task.await_approval',
    'task.complete', 'task.fail', 'task.cancelled', 'task.approval_resolved', 'agent.egress.reliable',
    'agent.message.draft', 'agent.message.publish', 'agent.content.receipt',
  ],
};

describe('wire v4 message types', () => {
  it('declares exactly the 28 v4 types, each with one envelope branch', () => {
    const all = [...V4_TYPES.hello, ...V4_TYPES.serverToDaemon, ...V4_TYPES.daemonToServer];
    expect(all).toHaveLength(28);
    expect([...MESSAGE_TYPES].sort()).toEqual([...all].sort());
    expect(EnvelopeSchema.options.map((schema) => schema.shape.type.value).sort()).toEqual([...all].sort());
    expect([...SERVER_TO_DAEMON_TYPES]).toEqual(V4_TYPES.serverToDaemon);
    expect([...DAEMON_TO_SERVER_TYPES]).toEqual(V4_TYPES.daemonToServer);
  });

  it('has one task-opening offer, and no sealed twin type', () => {
    expect(MESSAGE_TYPES.filter((type) => type.startsWith('task.offer'))).toEqual(['task.offer']);
    expect(MESSAGE_TYPES.filter((type) => type.endsWith('_sealed'))).toEqual([]);
  });
});
