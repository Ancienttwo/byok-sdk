import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  isKnownAgentEvent,
  partitionAgentEvents,
  type Envelope,
} from '@byok/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

/**
 * Client-side counterpart to the pre-freeze `AgentEventOrUnknownSchema`
 * tolerance added in `packages/protocol/src/agent-event.ts` (commit
 * 498616c). Investigation finding (Wave A2-client): the client is almost
 * entirely a PRODUCER of `task.progress`/AgentEvents, never a consumer —
 * `task.progress` is a `DAEMON_TO_SERVER_TYPES`-only message (see
 * `messages.ts`), and `TaskRunner.handleEnvelope`'s switch has no
 * `case 'task.progress'` at all, falling to `default: return;` (a complete
 * no-op) for it. So there is genuinely no client code path that inspects or
 * interprets AgentEvent contents from an INBOUND envelope.
 *
 * What this file proves instead, end to end, is that the client's inbound
 * pipeline never THROWS on such an envelope, even though it does nothing
 * with it — both layers a real inbound frame would pass through:
 *
 * 1. Decode: `decodeEnvelope` (re-exported from `@byok/protocol`, the same
 *    function `ws-transport.ts`'s WS `message` handler and (transitively,
 *    via `EventsPollResponseSchema`) `long-poll-transport.ts` both use) —
 *    already unknown-tolerant for free, purely by virtue of the client
 *    depending on the frozen protocol package rather than a hand-rolled
 *    duplicate schema.
 * 2. Dispatch: `TaskRunner.handleEnvelope` — proven to resolve cleanly
 *    (no-op) for a `task.progress` envelope regardless of whether it
 *    decoded with known or unknown events inside it.
 *
 * `ws-transport.ts`'s own WS message handler is not separately exercised
 * here: reading its source confirms it is a thin, two-step wrapper —
 * `decodeEnvelope(bytes)` (wrapped in a try/catch that already treats ANY
 * decode failure, including a fully unknown envelope `type`, as "ignore for
 * forward-compat") followed by `this.opts.onEnvelope(envelope)` — so
 * composing steps 1 and 2 above directly already covers its full behavior
 * without needing a real WebSocket in this test.
 */
describe('unknown AgentEvent tolerance on the client inbound path (pre-freeze protocol addition)', () => {
  it('decodeEnvelope parses a task.progress envelope containing a mix of known and unknown-type events without throwing', () => {
    const unknownEvent = { type: 'future_event_type_v2', someField: 'x', nested: { a: 1 } };
    const envelope = createEnvelope(
      'task.progress',
      {
        seq: 1,
        events: [{ type: 'progress', text: 'hi' }, unknownEvent, { type: 'turn_end' }],
      },
      { taskId: 'task-1' },
    );

    // Round-trip through the exact wire encoding a real WS/long-poll frame
    // uses (encode -> decode), not just re-validating the in-memory object.
    const wireLine = encodeEnvelope(envelope);
    let decoded: Envelope;
    expect(() => {
      decoded = decodeEnvelope(wireLine);
    }).not.toThrow();
    decoded = decodeEnvelope(wireLine);

    expect(decoded.type).toBe('task.progress');
    if (decoded.type !== 'task.progress') throw new Error('unreachable');

    const { known, unknown } = partitionAgentEvents(decoded.payload.events);
    expect(known).toEqual([{ type: 'progress', text: 'hi' }, { type: 'turn_end' }]);
    expect(unknown).toEqual([unknownEvent]);
    expect(decoded.payload.events.some((e) => !isKnownAgentEvent(e))).toBe(true);
  });

  it('TaskRunner.handleEnvelope processes an inbound task.progress carrying an unknown-type event as a no-op, never throwing', async () => {
    const sent: Envelope[] = [];
    const deps: TaskRunnerDeps = {
      adapters: [], // never consulted — task.progress touches no adapter/session machinery
      workspaceRoot: await tmpDir('byok-envelope-tolerance-workspace-'),
      deviceId: 'device-1',
      send: (envelope) => {
        sent.push(envelope);
      },
      blobClient: unusedBlobClient,
      sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-envelope-tolerance-store-')),
      approvalRegistry: new ApprovalRegistry(),
      storeDir: 'unused-store-dir',
      productId: 'unused-product-id',
    };
    const runner = new TaskRunner(deps);

    const envelope = createEnvelope(
      'task.progress',
      {
        seq: 1,
        events: [{ type: 'progress', text: 'hi' }, { type: 'a_type_this_client_has_never_heard_of', payload: 42 }],
      },
      { taskId: 'task-1' },
    );

    await expect(runner.handleEnvelope(envelope)).resolves.toBeUndefined();
    // Genuinely a no-op: task.progress is daemon->server only (see
    // `DAEMON_TO_SERVER_TYPES`, messages.ts) and TaskRunner never produces
    // any outbound envelope in response to receiving one inbound.
    expect(sent).toEqual([]);
    expect(runner.activeTaskCount).toBe(0);
  });
});
