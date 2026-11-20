import { MESSAGE_PAYLOAD_SCHEMAS } from '../messages';
import { describe, expect, it } from 'vitest';
import {
  DAEMON_TO_SERVER_TYPES,
  EnvelopeSchema,
  TaskApprovalResolvedPayloadSchema,
  TaskClaimPayloadSchema,
  TaskOfferPayloadSchema,
  CONN_HELLO_CAPABILITIES_MAX_ITEMS,
  TaskCompletePayloadSchema,
  TaskFailPayloadSchema,
  createEnvelope,
  decodeEnvelope,
  parseMessage,
} from '../index';
import { ConnHelloPayloadSchema, HarnessInfoSchema, TaskCancelledPayloadSchema } from '../messages';

const PI_EXECUTOR = { id: 'pi' } as const;

const HELLO = { protocolVersions: [8], capabilities: [], deviceId: 'device-1', productId: 'acme-agent' };
const DEFAULT_CAPS = { selectionModes: ['device-default'], effort: false };
const HARNESS = { id: 'claude', version: '1.2.3', authPresent: true, capabilities: DEFAULT_CAPS };

describe('conn.hello executor inventory', () => {
  it('accepts declared vendor and custom harnesses in one inventory', () => {
    const harnesses = [HARNESS, { id: 'acme-runner', capabilities: DEFAULT_CAPS }];
    expect(ConnHelloPayloadSchema.parse({ ...HELLO, harnesses }).harnesses).toEqual(harnesses);
  });

  it('accepts an empty inventory when no executor is available', () => {
    expect(ConnHelloPayloadSchema.parse({ ...HELLO, harnesses: [] }).harnesses).toEqual([]);
  });

  it('requires an inventory', () => {
    expect(ConnHelloPayloadSchema.safeParse(HELLO).success).toBe(false);
  });

  it('rejects duplicate identities', () => {
    expect(ConnHelloPayloadSchema.safeParse({ ...HELLO, harnesses: [HARNESS, HARNESS] }).success).toBe(false);
  });

  it('rejects an invalid identity', () => {
    expect(ConnHelloPayloadSchema.safeParse({ ...HELLO, harnesses: [{ ...HARNESS, id: 'Invalid ID' }] }).success).toBe(false);
  });

  it('keeps current fields when additional observability data arrives', () => {
    expect(ConnHelloPayloadSchema.parse({ ...HELLO, harnesses: [], agents: {}, cursor: 42 })).toEqual({ ...HELLO, harnesses: [], cursor: 42 });
  });

  it('bounds the capability list', () => {
    const hello = (count: number) => ({ ...HELLO, harnesses: [], capabilities: Array.from({ length: count }, (_, i) => `flag-${i}`) });
    expect(ConnHelloPayloadSchema.safeParse(hello(CONN_HELLO_CAPABILITIES_MAX_ITEMS)).success).toBe(true);
    expect(ConnHelloPayloadSchema.safeParse(hello(CONN_HELLO_CAPABILITIES_MAX_ITEMS + 1)).success).toBe(false);
  });

  it('rejects an executor without selection capability declarations', () => {
    expect(HarnessInfoSchema.safeParse({ id: 'pi' }).success).toBe(false);
  });

  it('preserves declared feature flags and strips unknown flags', () => {
    const info = HarnessInfoSchema.parse({ ...HARNESS, capabilities: { ...DEFAULT_CAPS, steer: true, resume: true, approvalInteractive: false, futureFlag: true } });
    expect(info.capabilities).toEqual({ ...DEFAULT_CAPS, steer: true, resume: true, approvalInteractive: false });
  });
});

/**
 * S0/D-4 (additive-minor): `task.claim.capabilities` — the claiming adapter's
 * own capability self-report, carried on the same message that establishes the
 * task↔runtime binding a server-side control gate keys off (see `messages.ts`'s
 * doc comment on `TaskClaimPayloadSchema`). Additive-only: one new optional
 * field reusing `RuntimeCapabilitiesSchema`, no `PROTOCOL_VERSION` bump
 * (docs/protocol.md §2.4 / "Freeze rule").
 */
describe('task.claim.capabilities (additive-minor optional field)', () => {
  it('accepts a claim carrying a fully-populated capabilities block', () => {
    const result = TaskClaimPayloadSchema.safeParse({
      deviceId: 'device-1',
      executor: PI_EXECUTOR,
      capabilities: {
        steer: true,
        resume: true,
        approvalInteractive: false,
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.capabilities).toEqual({
      steer: true,
      resume: true,
      approvalInteractive: false,
    });
  });

  it('accepts a claim carrying a partially-populated capabilities block', () => {
    const result = TaskClaimPayloadSchema.safeParse({
      deviceId: 'device-1',
      executor: { id: 'claude' },
      capabilities: { steer: false },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.capabilities).toEqual({ steer: false });
  });

  it('accepts a claim with capabilities omitted entirely (older daemon shape) and leaves the key absent, not defaulted', () => {
    // The absence must stay observable as absence: a consumer gating a control
    // decision on `capabilities.steer` has to be able to tell "not reported"
    // apart from "reported false", and fail closed on the former by its own
    // rule rather than by a schema-invented default.
    const result = TaskClaimPayloadSchema.safeParse({ deviceId: 'device-1', executor: PI_EXECUTOR });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect('capabilities' in result.data).toBe(false);
    expect(result.data.capabilities).toBeUndefined();
  });

  it('is the same shape as runtimes[].capabilities — an unknown flag inside it is stripped, not passed through', () => {
    const result = TaskClaimPayloadSchema.safeParse({
      deviceId: 'device-1',
      executor: PI_EXECUTOR,
      capabilities: { steer: true, futureFlag: 'from a newer daemon' },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.capabilities).toEqual({ steer: true });
  });

  it('rejects a non-boolean steer (control-relevant field keeps its type, no coercion)', () => {
    const result = TaskClaimPayloadSchema.safeParse({
      deviceId: 'device-1',
      executor: PI_EXECUTOR,
      capabilities: { steer: 'true' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object capabilities value outright', () => {
    const result = TaskClaimPayloadSchema.safeParse({ deviceId: 'device-1', executor: PI_EXECUTOR, capabilities: true });
    expect(result.success).toBe(false);
  });

  it('round-trips through the real wire entrypoint with capabilities intact', () => {
    const envelope = createEnvelope(
      'task.claim',
      { deviceId: 'device-1', executor: PI_EXECUTOR, capabilities: { steer: true, resume: true } },
      { taskId: 'task-1' },
    );
    const decoded = decodeEnvelope(`${JSON.stringify(envelope)}\n`);
    expect(decoded).toEqual(envelope);
    if (decoded.type !== 'task.claim') throw new Error('unreachable');
    expect(decoded.payload.capabilities).toEqual({ steer: true, resume: true });
  });

  it('a pre-S0 claim envelope (no capabilities) still validates — the field is additive, never required', () => {
    const envelope = createEnvelope('task.claim', { deviceId: 'device-1', executor: PI_EXECUTOR }, { taskId: 'task-1' });
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
    const decoded = decodeEnvelope(`${JSON.stringify(envelope)}\n`);
    if (decoded.type !== 'task.claim') throw new Error('unreachable');
    expect(decoded.payload.capabilities).toBeUndefined();
  });
});

describe('claimed executor (wire v7)', () => {
  it('refuses a claim without an executor', () => {
    expect(TaskClaimPayloadSchema.safeParse({ deviceId: 'device-1' }).success).toBe(false);
  });

  it('requires the executor on task.complete and leaves it optional on task.fail and task.cancelled', () => {
    expect(TaskCompletePayloadSchema.safeParse({ summary: 'done', sessionRef: 'sess-1' }).success).toBe(false);
    expect(TaskFailPayloadSchema.safeParse({ reason: 'interrupted before claim' }).success).toBe(true);
    expect(TaskCancelledPayloadSchema.safeParse({}).success).toBe(true);
  });
});

describe('taskId placement: envelope task_id is the sole routing key (M1 gap #7)', () => {
  it('an offer payload has no taskId field (the strict Agent offer refuses one)', () => {
    const result = TaskOfferPayloadSchema.safeParse({
      taskId: 'task-1', // M0 shape — payload-level duplicate, now meaningless
      instruction: 'do it',
      agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
      session: { mode: 'resume', sessionRef: 'session-1' },
      target: { lane: 'auto' },
    });
    expect(result.success).toBe(false);
  });

  it('task.claim payload no longer has a taskId field (stripped if present)', () => {
    const result = TaskClaimPayloadSchema.safeParse({
      taskId: 'task-1', // M0 shape — payload-level duplicate, now meaningless
      deviceId: 'device-1',
      executor: PI_EXECUTOR,
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
      v: 8,
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
      { deviceId: 'device-1', executor: PI_EXECUTOR },
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


describe('runtime messageDraft capability', () => {
  it('is optional discovery data in hello and claim', () => {
    const capabilities = { messageDraft: true };
    const hello = MESSAGE_PAYLOAD_SCHEMAS['conn.hello'].parse({
      protocolVersions: [8], capabilities: [], deviceId: 'device-1', productId: 'app',
      harnesses: [{ id: 'pi', version: '1', authPresent: true, capabilities: { ...DEFAULT_CAPS, ...capabilities } }],
    });
    expect(hello.harnesses[0]?.capabilities).toEqual({ ...DEFAULT_CAPS, ...capabilities });
    expect(MESSAGE_PAYLOAD_SCHEMAS['task.claim'].parse({ deviceId: 'device-1', executor: PI_EXECUTOR, capabilities }).capabilities).toEqual(capabilities);
    expect(MESSAGE_PAYLOAD_SCHEMAS['task.claim'].parse({ deviceId: 'device-1', executor: PI_EXECUTOR }).capabilities).toBeUndefined();
  });
});
