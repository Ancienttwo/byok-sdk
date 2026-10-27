// SDK half of #195 acceptance item 3: when the input cannot be honored, the SDK
// fails explicitly. It never truncates, guesses, mutates the original taskId's
// input, or switches model.
//
// Host-side blocking (missing history, budget, redaction) is Host-owned and is
// NOT simulated here. It is evidenced in Salesko
// `apps/api/src/private-agent-chat-context-pack.test.ts` at 4b1944c9:
// "unknown budget, fixture-in-production, and wrong model/version fail closed";
// "source limits and execution cap return exact blocking codes with no truncation";
// "wrong epoch source and missing source member reject, never null";
// "coverage hole fingerprint rejects even with a valid older candidate".
// Here the Host is only a caller of public server APIs against a real server
// and a real daemon over HTTP.
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import type { AgentEgressPolicy } from '@byok-sdk/protocol';
import { startServer, stopServer } from '../../../server/src/__tests__/test-support';
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { InMemoryDeviceCredentialStore } from './fixtures/device-credentials';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { OPEN_LIFECYCLE } from './fixtures/lifecycle-barrier';

const PRODUCT_ID = 'blocked-input-integration';
const AGENT_REF = { agentId: 'blocked-input-agent', profileRevision: 'profile-v1' };

async function withHarness(
  daemonPolicy: AgentEgressPolicy,
  body: (h: {
    sdk: ReturnType<typeof createByokServer>;
    adapter: StubRuntimeAdapter;
    deviceId: string;
    accepted: string[];
  }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-blocked-input-'));
  const accepted: string[] = [];
  const sdk = createByokServer({
    productId: PRODUCT_ID,
    longPollHoldMs: 50,
    storage: { kind: 'sqlite', path: path.join(root, 'server.sqlite') },
    agentMessage: { consume: async ({ taskId }: { taskId: string }) => { accepted.push(taskId); return { outcome: 'accepted' as const }; } },
  });
  const http = await startServer(sdk);
  const adapter = new StubRuntimeAdapter('pi');
  const daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-blocked-input-test' }, productName: 'blocked input test', productId: PRODUCT_ID,
    serverUrl: http.baseUrl, storeDir: path.join(root, 'store'),
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy: daemonPolicy },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  try {
    const pairing = await sdk.pairing.createPairingCode({ productId: PRODUCT_ID });
    const { deviceId } = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE));
    await body({ sdk, adapter, deviceId, accepted });
  } finally {
    await daemon.stop(); await sdk.close(); await stopServer(http.server);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function offeredInstruction(offer: Awaited<ReturnType<ReturnType<typeof createByokServer>['tasks']['offer']>>): unknown {
  if (!offer || !('instruction' in offer.payload)) throw new Error('offer has no instruction');
  return offer.payload.instruction;
}

async function codeOf(attempt: Promise<unknown>): Promise<string> {
  try { await attempt; } catch (error) {
    // @byok-sdk/cloud is not a client dependency; the server surface throws its ByokCloudError unchanged.
    if (error instanceof Error && error.name === 'ByokCloudError') return (error as Error & { code: string }).code;
    throw error;
  }
  throw new Error('expected a ByokCloudError rejection, but the call resolved');
}

// Three UTF-8 shapes; the comparison is on bytes, not on a normalized string.
const INSTRUCTION_A = 'Frozen input A: 中文 🐝 café';
const INSTRUCTION_B = 'Frozen input B: 中文 🐝 café, extended';

// #474 unified the former recurring.submit and dispatchFreshAgentEgress routes into the
// single executions.submit entry. Both former payload shapes remain reachable on it: with
// conversation message egress (the old recurring shape) and result-document only, without
// messageEgress or context (the old fresh-dispatch shape).
it.each([
  { shape: 'with message egress', withMessageEgress: true, expectedAccepted: 1 },
  { shape: 'without message egress', withMessageEgress: false, expectedAccepted: 0 },
] as const)(
  'rejects a second executions.submit ($shape) with different instruction bytes for the same taskId and leaves the first offer untouched',
  async ({ withMessageEgress, expectedAccepted }) => {
  await withHarness(DEFAULT_AGENT_EGRESS_POLICY, async ({ sdk, adapter, deviceId, accepted }) => {
    const taskId = `same-id-${withMessageEgress ? 'message-egress' : 'result-document'}`;
    const submit = (instruction: string) => sdk.executions.submit(withMessageEgress
      ? { taskId, deviceId, payload: {
        instruction, runtime: 'pi', agentRef: AGENT_REF, session: { mode: 'fresh' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
        terminalProjection: { mode: 'none' },
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn-0' } }
      : { taskId, deviceId, payload: {
        instruction, runtime: 'pi', agentRef: AGENT_REF, session: { mode: 'fresh' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        terminalProjection: { mode: 'none' },
      } });

    await submit(INSTRUCTION_A);
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), { timeout: 10000 });
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]?.task.instruction).toContain(INSTRUCTION_A);
    const offerBefore = await sdk.tasks.offer(taskId);
    expect(Buffer.from(offeredInstruction(offerBefore) as string)).toEqual(Buffer.from(INSTRUCTION_A));

    // The first attempt already has a durable delivered offer, so the kernel refuses the
    // reuse of the id (agent_task_already_exists) before it compares bodies. A different
    // body for an undelivered id would surface coordination_input_invalid instead; that
    // branch needs an append failure between reservation and delivery, which no public
    // server API can inject.
    expect(await codeOf(submit(INSTRUCTION_B))).toBe('agent_task_already_exists');

    const offerAfter = await sdk.tasks.offer(taskId);
    expect(offerAfter).toEqual(offerBefore);
    expect(Buffer.from(offeredInstruction(offerAfter) as string)).toEqual(Buffer.from(INSTRUCTION_A));
    expect(await sdk.tasks.attempt(taskId)).toMatchObject({ taskId, deviceId });

    // Let the first execution finish; a leaked second offer would have started by now.
    adapter.sessions[0]!.emit({ type: 'progress', text: 'A reply' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal(taskId)).toMatchObject({
      envelope: { type: 'task.complete' },
    }), { timeout: 10000 });
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.startCalls[0]?.task.instruction).not.toContain(INSTRUCTION_B);
    expect(accepted.length).toBe(expectedAccepted);
  });
  },
  30000,
);

it('declines a fresh Agent egress offer whose policy is not exactly the daemon policy, non-retryably and without a runtime start', async () => {
  const daemonPolicy: AgentEgressPolicy = { ...DEFAULT_AGENT_EGRESS_POLICY, policyRevision: 'daemon-v2' };
  await withHarness(daemonPolicy, async ({ sdk, adapter, deviceId }) => {
    const taskId = 'policy-mismatch';
    await sdk.executions.submit({ taskId, deviceId, payload: { instruction: INSTRUCTION_A, runtime: 'pi', agentRef: AGENT_REF,
      session: { mode: 'fresh' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: { mode: 'none' } } });
    await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal(taskId)).toMatchObject({
      envelope: { type: 'task.decline', payload: {
        reason: 'Agent egress offer policy is not exactly enabled by this daemon', retryable: false,
      } },
    }), { timeout: 10000 });
    expect(adapter.startCalls).toHaveLength(0);
    expect(adapter.sessions).toHaveLength(0);
    // The offer is neither rewritten to the daemon's policy nor re-targeted.
    const offer = await sdk.tasks.offer(taskId);
    expect(offer).toMatchObject({ type: 'task.offer', payload: {
      session: { mode: 'fresh' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, agentRef: AGENT_REF,
    } });
    expect(Buffer.from(offeredInstruction(offer) as string)).toEqual(Buffer.from(INSTRUCTION_A));
  });
}, 30000);

it('fails a fresh Agent egress offer whose instruction BlobRef cannot be resolved, retryably, without a runtime start or rewriting the offer', async () => {
  await withHarness(DEFAULT_AGENT_EGRESS_POLICY, async ({ sdk, adapter, deviceId }) => {
    const taskId = 'missing-instruction-blob';
    // Well-formed ref to a blob this server never stored. The daemon ignores BlobRef.url and
    // asks the server for a download URL by blobId, so the url here is deliberately inert.
    const blobRef = {
      blobId: 'blob_does_not_exist',
      contentHash: `sha256:${'a'.repeat(64)}`,
      size: 42,
      contentType: 'text/plain',
      url: 'http://127.0.0.1:1/never-listening',
    };
    await sdk.executions.submit({ taskId, deviceId, payload: {
      instruction: { blobRef }, runtime: 'pi', agentRef: AGENT_REF, session: { mode: 'fresh' }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
      terminalProjection: { mode: 'none' },
    }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn-0' } });
    await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal(taskId)).toMatchObject({
      envelope: { type: 'task.fail', payload: { retryable: true } },
    }), { timeout: 10000 });
    const terminal = await sdk.tasks.deviceTerminal(taskId);
    if (terminal?.envelope.type !== 'task.fail' || terminal.envelope.payload.sealed !== undefined) throw new Error('expected a plaintext task.fail');
    expect(terminal.envelope.payload.reason.startsWith('failed to resolve instruction blob:')).toBe(true);
    expect(adapter.startCalls).toHaveLength(0);
    expect(adapter.sessions).toHaveLength(0);
    // The offer still carries the same BlobRef: nothing was inlined, substituted or truncated.
    expect(offeredInstruction(await sdk.tasks.offer(taskId))).toEqual({ blobRef });
  });
}, 30000);
