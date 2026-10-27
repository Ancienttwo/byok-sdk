/**
 * The daemon's own admission check on `task.offer` (#925 stage 2, owner
 * decision O4): a daemon that knows every field of an offer but did not
 * advertise a flag the offer's gates name declines it, non-retryably, before
 * it opens a sealed offer or starts a runtime. Each case skips the sender's
 * admission by writing the offer straight to the mailbox, as a sender that
 * forgot a gate would.
 */
import { readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope, type TaskOfferPayload } from '@byok-sdk/protocol';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { SealedTasks } from '../daemon/sealed-task';
import { testScratchRoot } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

type Json = Record<string, unknown>;

const roots: string[] = [];
let server: TestServer | undefined;
let daemon: Daemon | undefined;

const agentRef = { agentId: 'self-check-agent', profileRevision: 'profile-r1' } as const;

const corpusOffers = readFileSync(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: string; payload: Json })
  .filter((line) => line.type === 'task.offer')
  .map((line) => line.payload);

/** A corpus offer with only the fields the case is about: the other gated fields would add their own missing flags. */
function corpusOffer(match: (payload: Json) => boolean): Json {
  const payload = corpusOffers.find(match);
  if (payload === undefined) throw new Error('no matching corpus offer');
  const { dispatchSelection: _d, requiredToolsets: _t, terminalProjection: _p, homeAccess: _h, harnessId: _x, messageEgress: _m, ...rest } = payload;
  return { ...rest, runtime: 'pi' };
}

async function tmpDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await daemon?.stop();
  daemon = undefined;
  await server?.close();
  server = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

interface GapCase {
  readonly name: string;
  readonly egress: boolean;
  readonly payload: () => Json;
  /** The flag the daemon did not advertise. */
  readonly missing: string;
  /**
   * A task that seals its output declines with the sealed code instead of
   * free text; the server must accept sealed task output for that code.
   */
  readonly sealedCode?: string;
}

const CASES: readonly GapCase[] = [
  {
    name: 'egressPolicy on a daemon without Agent egress',
    egress: false,
    payload: () => ({ agentRef, session: { mode: 'resume', sessionRef: 'session-1' }, instruction: 'x', runtime: 'pi', egressPolicy: DEFAULT_AGENT_EGRESS_POLICY }),
    missing: 'agent-egress-policy',
  },
  {
    name: 'preparation on a daemon without input preparation',
    egress: true,
    payload: () => corpusOffer((payload) => payload.preparation !== undefined),
    missing: 'agent-input-preparation-v9',
  },
  {
    name: 'sealing on a daemon without sealed-payload-v1',
    egress: true,
    payload: () => corpusOffer((payload) => payload.sealed !== undefined && (payload.session as Json).mode === 'resume' && payload.egressPolicy === undefined),
    missing: 'sealed-payload-v1',
    sealedCode: 'sealed_key_unavailable',
  },
  {
    name: 'a fresh session on a daemon with an Agent home but without fresh egress sessions',
    egress: false,
    payload: () => ({ agentRef, session: { mode: 'fresh' }, instruction: 'x', runtime: 'pi', egressPolicy: DEFAULT_AGENT_EGRESS_POLICY }),
    missing: 'agent-egress-fresh-session',
  },
];

describe('task.offer self-check: a daemon declines an offer whose gates name a flag it did not advertise (O4)', () => {
  it.each(CASES.map((gap) => [gap.name, gap] as const))('%s', async (_name, gap) => {
    const openOffer = vi.spyOn(SealedTasks.prototype, 'openOffer');
    server = await TestServer.start();
    if (gap.sealedCode !== undefined) server.setAckCapabilities(['sealed-payload-v1']);
    const storeDir = await tmpDir('byok-offer-self-check-store-');
    const hostStorageRoot = await tmpDir('byok-offer-self-check-home-');
    const adapter = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters(
      {
        storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-offer-self-check' },
        productName: 'Offer self-check test',
        productId: 'offer-self-check-test',
        serverUrl: server.url,
        storeDir,
        agentHome: { hostStorageRoot },
        ...(gap.egress ? { agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } } : {}),
      },
      [adapter],
    );
    const { deviceId } = await daemon.pair('offer-self-check-pair-code');
    await daemon.start();
    const hello = await server.waitFor((envelope) => envelope.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('expected conn.hello');
    expect(hello.payload.capabilities).toContain('agent-home-contract');
    expect(hello.payload.capabilities).not.toContain(gap.missing);

    const taskId = `self-check-${gap.missing}`;
    const seq = server.nextSeq();
    server.send(createEnvelope('task.offer', gap.payload() as TaskOfferPayload, { taskId, seq }));

    const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === taskId);
    if (decline.type !== 'task.decline' || decline.payload.sealed !== undefined) throw new Error('expected a plaintext task.decline');
    expect(decline.payload.retryable).toBe(false);
    if (gap.sealedCode === undefined) {
      expect(decline.payload.reason).toMatch(/^offer_capability_missing: /u);
      expect(decline.payload.reason).toContain(gap.missing);
    } else {
      expect(decline.payload).toMatchObject({ code: gap.sealedCode, reason: gap.sealedCode });
    }
    expect(openOffer).not.toHaveBeenCalled();
    expect(adapter.startCalls).toHaveLength(0);
    expect(server.received.some((envelope: Envelope) => envelope.type === 'task.claim' && envelope.task_id === taskId)).toBe(false);
    // A decline is terminal, so the cursor moves past the offer.
    await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server!.url, deviceId)).toBeGreaterThanOrEqual(seq));
  });
});
