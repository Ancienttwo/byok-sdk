import { describe, expect, it } from 'vitest';
import {
  ConnHelloPayloadSchema,
  DAEMON_TO_SERVER_TYPES,
  EnvelopeSchema,
  RuntimeInfoSchema,
  TaskApprovalResolvedPayloadSchema,
  TaskClaimPayloadSchema,
  TaskOfferPayloadSchema,
  createEnvelope,
  decodeEnvelope,
  parseMessage,
} from '../index';

describe('conn.hello: runtimes replaces agents (M1 gap #4)', () => {
  it('accepts a typed runtimes array', () => {
    const result = ConnHelloPayloadSchema.safeParse({
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'acme-agent',
      runtimes: [
        { id: 'claude', version: '1.2.3', authPresent: true },
        { id: 'pi' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtimes).toEqual([
        { id: 'claude', version: '1.2.3', authPresent: true },
        { id: 'pi' },
      ]);
    }
  });

  it('rejects a runtimes entry with an unknown runtime id', () => {
    const result = ConnHelloPayloadSchema.safeParse({
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'acme-agent',
      runtimes: [{ id: 'gpt-5' }],
    });
    expect(result.success).toBe(false);
  });

  it('runtimes is optional (a device may report none yet)', () => {
    const result = ConnHelloPayloadSchema.safeParse({
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'acme-agent',
    });
    expect(result.success).toBe(true);
  });

  it('the old untyped "agents" field is no longer part of the schema (silently stripped, not required)', () => {
    const result = ConnHelloPayloadSchema.safeParse({
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'acme-agent',
      agents: { claude: { authPresent: true } }, // M0 shape — no longer meaningful
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('agents' in result.data).toBe(false);
    }
  });

  it('conn.hello accepts an M1 redelivery cursor', () => {
    const result = ConnHelloPayloadSchema.safeParse({
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'acme-agent',
      cursor: 42,
    });
    expect(result.success).toBe(true);
  });
});

describe('runtimes[].capabilities: per-runtime feature flags (pre-freeze addition)', () => {
  it('accepts a runtime entry with capabilities fully populated', () => {
    const result = RuntimeInfoSchema.safeParse({
      id: 'claude',
      capabilities: {
        steer: true,
        resume: true,
        approvalInteractive: false,
        permissionModes: ['auto', 'confirm'],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual({
        steer: true,
        resume: true,
        approvalInteractive: false,
        permissionModes: ['auto', 'confirm'],
      });
    }
  });

  it('accepts a runtime entry with capabilities only partially populated (partial detection)', () => {
    const result = RuntimeInfoSchema.safeParse({
      id: 'codex',
      capabilities: { approvalInteractive: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual({ approvalInteractive: true });
    }
  });

  it('accepts a runtime entry with capabilities omitted entirely (older daemon shape)', () => {
    const result = RuntimeInfoSchema.safeParse({ id: 'pi' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('capabilities' in result.data).toBe(false);
    }
  });

  it('permissionModes tolerates a mode string this schema does not enumerate (observability data, not control/security)', () => {
    const result = RuntimeInfoSchema.safeParse({
      id: 'claude',
      capabilities: { permissionModes: ['auto', 'confirm', 'some-future-mode'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities?.permissionModes).toEqual(['auto', 'confirm', 'some-future-mode']);
    }
  });

  it('strips unknown keys inside capabilities (documented schema choice: strip, not passthrough)', () => {
    const result = RuntimeInfoSchema.safeParse({
      id: 'pi',
      capabilities: { steer: true, futureFlag: 'from a newer daemon' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual({ steer: true });
      expect(result.data.capabilities && 'futureFlag' in result.data.capabilities).toBe(false);
    }
  });

  it('conn.hello validates with a runtimes[].capabilities present', () => {
    const result = ConnHelloPayloadSchema.safeParse({
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'acme-agent',
      runtimes: [{ id: 'claude', capabilities: { steer: true } }],
    });
    expect(result.success).toBe(true);
  });

  it('conn.hello validates with runtimes[].capabilities absent', () => {
    const result = ConnHelloPayloadSchema.safeParse({
      protocolVersions: [1],
      capabilities: [],
      deviceId: 'device-1',
      productId: 'acme-agent',
      runtimes: [{ id: 'claude' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('taskId placement: envelope task_id is the sole routing key (M1 gap #7)', () => {
  it('task.offer payload no longer has a taskId field (stripped if present)', () => {
    const result = TaskOfferPayloadSchema.safeParse({
      taskId: 'task-1', // M0 shape — payload-level duplicate, now meaningless
      instruction: 'do it',
      policy: { mode: 'auto' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('taskId' in result.data).toBe(false);
    }
  });

  it('task.claim payload no longer has a taskId field (stripped if present)', () => {
    const result = TaskClaimPayloadSchema.safeParse({
      taskId: 'task-1', // M0 shape — payload-level duplicate, now meaningless
      deviceId: 'device-1',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('taskId' in result.data).toBe(false);
    }
  });

  it('an M0-shaped task.claim envelope (payload.taskId, no envelope.task_id) fails validation', () => {
    // What an un-migrated M0 daemon would have sent: taskId lives only in the
    // payload, and the envelope never sets task_id. M1 requires the envelope
    // field, so this must now be rejected rather than silently unroutable.
    const raw = {
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      ts: new Date().toISOString(),
      type: 'task.claim',
      payload: { taskId: 'task-1', deviceId: 'device-1' },
      // no top-level task_id
    };
    expect(() => parseMessage(raw)).toThrow();
    expect(EnvelopeSchema.safeParse(raw).success).toBe(false);
  });

  it('an M1-shaped task.claim envelope (envelope.task_id, no payload.taskId) is valid and routes correctly', () => {
    const envelope = createEnvelope(
      'task.claim',
      { deviceId: 'device-1' },
      { taskId: 'task-1' },
    );
    const parsed = parseMessage(envelope);
    expect(parsed.task_id).toBe('task-1');
    expect('taskId' in parsed.payload).toBe(false);
  });
});

/**
 * M4 (additive-minor): `task.approval_resolved` — daemon -> server report of
 * a LOCALLY-resolved approval (see `messages.ts`'s own doc comment on
 * `TaskApprovalResolvedPayloadSchema` for the full rationale). Additive-only:
 * a new message type + a new capability flag, no `PROTOCOL_VERSION` bump
 * (docs/protocol.md "Freeze rule").
 */
describe('task.approval_resolved (additive-minor message)', () => {
  it('is registered as a daemon -> server type', () => {
    expect(DAEMON_TO_SERVER_TYPES).toContain('task.approval_resolved');
  });

  it('schema round-trip: a well-formed payload parses with every field intact', () => {
    const result = TaskApprovalResolvedPayloadSchema.safeParse({
      approvalId: 'appr-1',
      decision: 'approve',
      resolvedBy: 'local',
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({
      approvalId: 'appr-1',
      decision: 'approve',
      resolvedBy: 'local',
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('accepts decision: reject too', () => {
    const result = TaskApprovalResolvedPayloadSchema.safeParse({
      approvalId: 'appr-2',
      decision: 'reject',
      resolvedBy: 'local',
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized decision value', () => {
    const result = TaskApprovalResolvedPayloadSchema.safeParse({
      approvalId: 'appr-1',
      decision: 'maybe',
      resolvedBy: 'local',
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it("rejects a resolvedBy value other than 'local' (single-value enum today, future-proof for an additive future member)", () => {
    const result = TaskApprovalResolvedPayloadSchema.safeParse({
      approvalId: 'appr-1',
      decision: 'approve',
      resolvedBy: 'operator-cli',
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('unknown-field tolerance: an unrecognized sibling field is silently stripped, not rejected (observability-class, not control/security)', () => {
    const result = TaskApprovalResolvedPayloadSchema.safeParse({
      approvalId: 'appr-1',
      decision: 'approve',
      resolvedBy: 'local',
      at: '2026-01-01T00:00:00.000Z',
      futureField: 'from a newer minor version',
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect('futureField' in result.data).toBe(false);
  });

  it('envelope.task_id is required (routes by task, like every other task.* type)', () => {
    const envelope = createEnvelope(
      'task.approval_resolved',
      { approvalId: 'appr-1', decision: 'approve', resolvedBy: 'local', at: '2026-01-01T00:00:00.000Z' },
      { taskId: 'task-1' },
    );
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
    const { task_id: _taskId, ...withoutTaskId } = envelope as Record<string, unknown>;
    expect(EnvelopeSchema.safeParse(withoutTaskId).success).toBe(false);
  });

  it('envelope.seq stays optional (daemon -> server type, same as every other one)', () => {
    const envelope = createEnvelope(
      'task.approval_resolved',
      { approvalId: 'appr-1', decision: 'approve', resolvedBy: 'local', at: '2026-01-01T00:00:00.000Z' },
      { taskId: 'task-1' },
    );
    expect('seq' in envelope).toBe(false);
  });

  it('round-trips through the real wire entrypoint (decodeEnvelope on an encoded line)', () => {
    const envelope = createEnvelope(
      'task.approval_resolved',
      { approvalId: 'appr-1', decision: 'reject', resolvedBy: 'local', at: '2026-01-01T00:00:00.000Z' },
      { taskId: 'task-1' },
    );
    const wireLine = `${JSON.stringify(envelope)}\n`;
    const decoded = decodeEnvelope(wireLine);
    expect(decoded).toEqual(envelope);
  });
});
