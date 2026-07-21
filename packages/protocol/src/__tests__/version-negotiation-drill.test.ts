import { describe, expect, it } from 'vitest';
import {
  ConnAckPayloadSchema,
  ConnHelloPayloadSchema,
  createEnvelope,
  decodeEnvelope,
  MESSAGE_PAYLOAD_SCHEMAS,
  parseMessage,
  RuntimeInfoSchema,
} from '../index';

/**
 * M4 Phase 4: the version-negotiation compat-matrix drill. A self-contained
 * artifact simulating a future minor server against today's daemon (and
 * vice versa) — proving the wire's stated additive-compat promise
 * (version.ts: "additive changes ... do not require a bump ... daemons/
 * servers must ignore unknown fields and unknown message types") actually
 * holds, and pinning down exactly where it does NOT (control/security data
 * stays fail-closed by design — see docs/protocol.md "Freeze rule").
 *
 * Four scenarios, each noting where its REAL evidence lives:
 *
 *   1. Unknown ADDITIVE fields on observability-class messages -> parsed,
 *      ignored, no throw. Tested here directly against several payload
 *      schemas (this file) — pure schema-level, no cross-package dependency
 *      needed. `freeze-guard.test.ts` (this package) already covers the
 *      adjacent "unknown AgentEvent VARIANT inside task.progress.events[]"
 *      case; this file adds the complementary "unknown SIBLING FIELD
 *      alongside seq/events" angle, which that test doesn't exercise.
 *   2. Unknown NEW message type -> ignore/skip. The protocol-level half
 *      (parseMessage/decodeEnvelope throw a distinctly-catchable
 *      `UnknownMessageTypeError`) is already pinned in `freeze-guard.test.ts`.
 *      The actual dispatch-layer behavior (what a REAL client transport does
 *      with that thrown error) lives in `packages/client` — this package has
 *      no dependency on `@byok/client` or `@byok/server` to reach it (see
 *      each package's `package.json`), so per this drill's own instructions
 *      those assertions live in
 *      `packages/client/src/__tests__/unknown-message-type-tolerance.test.ts`
 *      instead, driven against the REAL `ConnectionManager`/`WsTransport`/
 *      `LongPollClient` — not a reimplementation. That file FOUND AND FIXED a
 *      genuine asymmetry: WS tolerates an unknown frame type per-message
 *      (skip and continue) — the pre-existing, correct behavior — but
 *      long-poll's whole-batch `EventsPollResponseSchema.parse()` used to
 *      fail the ENTIRE poll batch on a single unrecognized-type entry. Fixed
 *      client-side (`long-poll-transport.ts`/`connection-manager.ts`,
 *      per-entry `parseMessage` + cursor-advance-past-a-skip), zero wire/
 *      protocol change — see docs/protocol.md §13 for the full writeup.
 *   3. Unknown fields on control/security-class schemas (`PermissionPolicySchema`,
 *      the `instruction` blob-ref variant) -> `.strict()` rejection
 *      (fail-closed). Already thoroughly covered by `freeze-guard.test.ts`'s
 *      "behavior assertions" describe block via the bare payload schemas
 *      directly; this file does NOT duplicate that coverage; it adds ONE
 *      thing that block doesn't: routing the same two cases through the
 *      REAL end-to-end decode entrypoint (`parseMessage`/`decodeEnvelope` on
 *      a full wire-shaped envelope), not just the isolated payload schema.
 *      No golden-sample (`golden/v1.frozen.json`/`v1.envelopes.ndjson`)
 *      extension was needed for either 1 or 3: both are proven by direct,
 *      inline `safeParse`/`parseMessage` assertions, which is the existing,
 *      already-established convention for exactly this kind of behavior
 *      check in this file's sibling (see `freeze-guard.test.ts`'s own "Part
 *      3" describe block) — the golden files are a different, narrower net
 *      (pinning exact schema shape / exact historical wire bytes), not the
 *      right tool for a tolerate-vs-reject behavior assertion.
 *   4. Handshake version negotiation: daemon advertising [1,1] vs. server
 *      supporting [1,2] -> agrees on 1; disjoint ranges -> clean, typed
 *      failure, not a hang. The SCHEMA half (this file): `conn.hello`
 *      accepts a multi-entry `protocolVersions` array either way (the
 *      schema itself never referees which entries "count" — that's a
 *      semantic decision, not a shape constraint), and `conn.ack` can only
 *      ever express a SINGLE agreed-upon `protocolVersion`, which is what
 *      makes "agrees on 1" a well-formed reply at all. The actual
 *      accept-or-reject NEGOTIATION DECISION is `ws-server.ts`'s own
 *      handshake code (`packages/server`) — protocol has no dependency on
 *      that package either, so per this drill's own instructions ("find the
 *      real negotiation code ... and test through it, not through a
 *      reimplementation") that behavioral test lives in
 *      `packages/server/src/__tests__/version-negotiation.test.ts`, driven
 *      against the real `attachWebSocket`/`ConnectionHub` handshake over a
 *      real WS connection.
 */
describe('M4 Phase 4 version-negotiation drill', () => {
  describe('item 1: unknown additive fields on observability-class payloads are tolerated (parsed, field stripped, no throw)', () => {
    it('an unknown SIBLING field alongside task.progress.seq/events (not an unknown AgentEvent variant — see freeze-guard.test.ts for that case) is silently stripped', () => {
      const result = MESSAGE_PAYLOAD_SCHEMAS['task.progress'].safeParse({
        seq: 1,
        events: [{ type: 'progress', text: 'hi' }],
        futureObservabilityField: 'from a newer minor version',
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect('futureObservabilityField' in result.data).toBe(false);
    });

    it('an unknown field on task.artifact is silently stripped', () => {
      const result = MESSAGE_PAYLOAD_SCHEMAS['task.artifact'].safeParse({
        name: 'out.txt',
        contentType: 'text/plain',
        inline: 'aGVsbG8=',
        futureArtifactMeta: { checksum: 'x' },
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect('futureArtifactMeta' in result.data).toBe(false);
    });

    it("an unknown field on conn.ack (simulating a future minor SERVER's handshake reply against today's daemon) is silently stripped, through the REAL end-to-end decode entrypoint", () => {
      const envelope = createEnvelope(
        'conn.ack',
        { protocolVersion: 1, capabilities: ['steer'], serverTime: '2026-01-01T00:00:00.000Z' },
        { seq: 1 },
      );
      const withFutureField = { ...envelope, payload: { ...envelope.payload, serverBuildId: 'v1.1.0-hypothetical' } };

      const parsed = parseMessage(withFutureField);
      expect(parsed.type).toBe('conn.ack');
      if (parsed.type !== 'conn.ack') throw new Error('unreachable');
      expect('serverBuildId' in parsed.payload).toBe(false);
      expect(parsed.payload.protocolVersion).toBe(1);

      // decodeEnvelope (the actual wire-bytes entrypoint, not just parseMessage
      // on an in-memory object) tolerates it identically.
      const wireLine = `${JSON.stringify(withFutureField)}\n`;
      expect(() => decodeEnvelope(wireLine)).not.toThrow();
    });

    it('an unknown field on a per-runtime RuntimeInfo.capabilities entry (conn.hello.runtimes[], simulating a future daemon reporting to today\'s server) is silently stripped', () => {
      const result = RuntimeInfoSchema.safeParse({
        id: 'claude',
        version: '2.2.0',
        capabilities: { steer: true, resume: true, futureCapabilityField: true },
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect('futureCapabilityField' in (result.data.capabilities as Record<string, unknown>)).toBe(false);
    });
  });

  describe('item 3: unknown fields on control/security-class schemas are REJECTED, fail-closed (already established in freeze-guard.test.ts — restated here through the real end-to-end decode entrypoint)', () => {
    it('a task.offer with an unrecognized field on an otherwise well-formed `policy`, decoded through the REAL wire entrypoint (decodeEnvelope), is rejected', () => {
      const envelope = createEnvelope('task.offer', { instruction: 'do it', policy: { mode: 'auto' } }, { taskId: 'task-1', seq: 1 });
      const withFutureConstraint = {
        ...envelope,
        payload: { ...envelope.payload, policy: { ...envelope.payload.policy, futureConstraint: 'x' } },
      };
      const wireLine = `${JSON.stringify(withFutureConstraint)}\n`;
      expect(() => decodeEnvelope(wireLine)).toThrow();
    });

    it('a task.offer with an unrecognized field alongside an otherwise well-formed `instruction.blobRef`, decoded through the REAL wire entrypoint, is rejected', () => {
      const envelope = createEnvelope(
        'task.offer',
        {
          instruction: {
            blobRef: { blobId: 'blob-1', contentHash: `sha256:${'a'.repeat(64)}`, size: 10, contentType: 'text/plain' },
          },
          policy: { mode: 'auto' },
        },
        { taskId: 'task-1', seq: 1 },
      );
      const withFutureField = {
        ...envelope,
        payload: {
          ...envelope.payload,
          instruction: { ...(envelope.payload.instruction as object), futureControlField: 'x' },
        },
      };
      const wireLine = `${JSON.stringify(withFutureField)}\n`;
      expect(() => decodeEnvelope(wireLine)).toThrow();
    });

    it('sanity: the identical policy WITHOUT the unknown field still decodes fine through the same real entrypoint (isolates the rejection to the unknown field, not something else in the fixture)', () => {
      const envelope = createEnvelope('task.offer', { instruction: 'do it', policy: { mode: 'auto' } }, { taskId: 'task-1', seq: 1 });
      const wireLine = `${JSON.stringify(envelope)}\n`;
      expect(() => decodeEnvelope(wireLine)).not.toThrow();
    });
  });

  describe('item 4 (schema half): conn.hello/conn.ack shapes support "advertise several, agree on one" — the actual accept/reject DECISION is server-side (see packages/server/src/__tests__/version-negotiation.test.ts)', () => {
    it('conn.hello.protocolVersions accepts a multi-entry array overlapping the server\'s version (e.g. a daemon simulating "I can also speak a hypothetical v2, but still list today\'s v1 too")', () => {
      const result = ConnHelloPayloadSchema.safeParse({
        protocolVersions: [1, 2],
        capabilities: [],
        deviceId: 'device-1',
        productId: 'acme-agent',
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect(result.data.protocolVersions).toEqual([1, 2]);
    });

    it("conn.hello.protocolVersions accepts a DISJOINT array too — the schema itself never referees negotiation, it only validates shape (the real accept/reject decision is ws-server.ts's own semantic check, not a schema constraint)", () => {
      const result = ConnHelloPayloadSchema.safeParse({
        protocolVersions: [2, 3],
        capabilities: [],
        deviceId: 'device-1',
        productId: 'acme-agent',
      });
      expect(result.success).toBe(true); // well-formed shape; NOT a claim that a real server would accept this connection
    });

    it('conn.ack.protocolVersion can only ever express a SINGLE resolved version (not a range) — this is what makes "agrees on 1" a well-formed reply at all', () => {
      const result = ConnAckPayloadSchema.safeParse({
        protocolVersion: 1,
        capabilities: [],
        serverTime: '2026-01-01T00:00:00.000Z',
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect(typeof result.data.protocolVersion).toBe('number');
    });
  });

  // Reference point so "where's the rest of the drill" never requires
  // re-deriving it from scratch:
  //   - item 2 (behavioral): packages/client/src/__tests__/unknown-message-type-tolerance.test.ts
  //   - item 4 (behavioral): packages/server/src/__tests__/version-negotiation.test.ts
});
