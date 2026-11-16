import { describe, expect, it } from 'vitest';
import { DAEMON_TO_SERVER_TYPES, EnvelopeSchema, MESSAGE_TYPES, SERVER_TO_DAEMON_TYPES, isSealableMessageType } from '../index';

/** The wire message types: the v4 set (#925 stage 2 design, Q1) plus v7's task.steer_refused (#2009), by direction. */
const WIRE_TYPES = {
  hello: ['conn.hello'],
  serverToDaemon: [
    'task.offer', 'agent.egress.ack', 'agent.message.disposition', 'agent.content.read', 'agent.home.projection',
    'agent.input.preparation', 'provider.provisioning.available', 'agent.memory.intent.available', 'task.approve',
    'task.reject', 'task.cancel', 'task.steer', 'e2ee.key_package.available',
  ],
  daemonToServer: [
    'task.claim', 'task.started', 'task.decline', 'task.progress', 'task.artifact', 'task.await_approval',
    'task.complete', 'task.fail', 'task.cancelled', 'task.approval_resolved', 'task.steer_refused', 'agent.egress.reliable',
    'agent.message.draft', 'agent.message.publish', 'agent.content.receipt',
  ],
};

describe('wire message types', () => {
  it('declares exactly the 29 types, each with one envelope branch', () => {
    const all = [...WIRE_TYPES.hello, ...WIRE_TYPES.serverToDaemon, ...WIRE_TYPES.daemonToServer];
    expect(all).toHaveLength(29);
    expect([...MESSAGE_TYPES].sort()).toEqual([...all].sort());
    expect(EnvelopeSchema.options.map((schema) => schema.shape.type.value).sort()).toEqual([...all].sort());
    expect([...SERVER_TO_DAEMON_TYPES]).toEqual(WIRE_TYPES.serverToDaemon);
    expect([...DAEMON_TO_SERVER_TYPES]).toEqual(WIRE_TYPES.daemonToServer);
  });

  it('has one task-opening offer, and no sealed twin type', () => {
    expect(MESSAGE_TYPES.filter((type) => type.startsWith('task.offer'))).toEqual(['task.offer']);
    expect(MESSAGE_TYPES.filter((type) => type.endsWith('_sealed'))).toEqual([]);
  });
});

describe('isSealableMessageType', () => {
  it('is true for task.offer and false for unknown lookalikes and inherited object keys', () => {
    expect(isSealableMessageType('task.offer')).toBe(true);
    for (const type of ['task.offer_sealed', 'task.offer_unknown', 'toString', '__proto__', 'constructor', 'hasOwnProperty', '']) {
      expect(isSealableMessageType(type), type).toBe(false);
    }
  });
});
