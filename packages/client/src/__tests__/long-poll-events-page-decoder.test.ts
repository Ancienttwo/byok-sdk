import { createTestDeviceStore } from './fixtures/device-credentials';
/**
 * #386 decoder cutover: the daemon decodes the outer `/byok/events` page with
 * protocol's `EventsPollResponseSchema`, then each entry on its own with
 * `parseMessage`. A malformed page is a route failure on the 200 it arrived
 * with (the schema failure rides in `cause`) and ends the loop generation
 * without handing anything to `onEnvelope`. The cursor's safe-nonnegative and
 * no-regression checks stay client-local. An unknown entry inside a valid page
 * still stalls only its own sequence. `global.fetch` is mocked, as in
 * `long-poll-validation-stall.test.ts`.
 */
import { PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { LongPollClient, LongPollRouteError } from '../daemon/long-poll-transport';
import { seedDeviceEnrollment } from './fixtures/device-enrollment';
import { TEST_ACTIVITY_INGRESS as ingress } from './fixtures/activity-ingress';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('LongPollClient decodes the events page with EventsPollResponseSchema (#386)', () => {
  let auth: AuthManager;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const store = createTestDeviceStore(await tmpDir('byok-lp-page-decoder-store-'));
    await seedDeviceEnrollment(store, {
      deviceId: 'dev-1',
      tenantId: 'tenant-long-poll',
      accessToken: 'tok-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), // far future — never renews, never touches the network
      devicePrivateKeyPem: 'unused-in-this-test',
      devicePublicKey: 'unused-in-this-test',
    });
    auth = new AuthManager({ serverUrl: 'http://example.invalid', store });
    await auth.loadExisting();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnMock.mockRestore();
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  function warnedRouteErrors(): LongPollRouteError[] {
    return (warnMock.mock.calls as unknown[][])
      .map((call) => call[1])
      .filter((arg): arg is LongPollRouteError => arg instanceof LongPollRouteError);
  }

  /** Runs one loop generation against `body` and returns how it ended. */
  async function pollOnce(body: unknown) {
    fetchMock.mockResolvedValue(jsonResponse(body));
    const onEnvelope = vi.fn();
    const onValidationFailedSeq = vi.fn();
    const onServerCapabilities = vi.fn();
    const outcomes: string[] = [];
    let loopFailures = 0;
    const client: LongPollClient = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => undefined,
      onEnvelope,
      onValidationFailedSeq,
      onServerCapabilities,
      onOperationalOutcome: (outcome) => outcomes.push(outcome),
      onLoopFailure: () => {
        loopFailures += 1;
        client.stop();
      },
      retryDelayMs: 50,
      idleDelayMs: 20,
    });
    client.start();
    await vi.waitFor(() => expect(loopFailures).toBe(1));
    client.stop();
    return { onEnvelope, onValidationFailedSeq, onServerCapabilities, outcomes, error: warnedRouteErrors()[0] };
  }

  const validOffer = {
    v: PROTOCOL_VERSION,
    id: 'ffffffff-ffff-4fff-8fff-ffffffffff40',
    ts: new Date().toISOString(),
    type: 'task.offer_for_agent',
    task_id: 'good-task',
    seq: 1,
    payload: { agentRef: { agentId: 'agent-long-poll', profileRevision: 'rev-1' }, instruction: 'do it' },
  };

  it.each([
    ['events is not an array', { events: { 0: validOffer }, cursor: 1, capabilities: [], ingress }, ['events']],
    ['events is missing', { cursor: 1, capabilities: [], ingress }, ['events']],
    ['cursor is not an integer', { events: [validOffer], cursor: 1.5, capabilities: [], ingress }, ['cursor']],
    ['cursor is a string', { events: [validOffer], cursor: '1', capabilities: [], ingress }, ['cursor']],
    ['cursor is not a safe integer', { events: [], cursor: Number.MAX_SAFE_INTEGER + 1, capabilities: [], ingress }, ['cursor']],
    ['capabilities is not a string array', { events: [validOffer], cursor: 1, capabilities: [7], ingress }, ['capabilities', 0]],
    // Wire v3: the capability and activity ingress advertisements are required on every page.
    ['capabilities is missing', { events: [validOffer], cursor: 1, ingress }, ['capabilities']],
    ['ingress is missing', { events: [validOffer], cursor: 1, capabilities: [] }, ['ingress']],
    ['ingress is malformed', { events: [validOffer], cursor: 1, capabilities: [], ingress: { activityMaxEvents: 0, activityMaxBytes: 65536 } }, ['ingress', 'activityMaxEvents']],
  ])('rejects a page whose %s through the outer schema, as a route failure on its 200', async (_case, body, issuePath) => {
    const { onEnvelope, onValidationFailedSeq, onServerCapabilities, outcomes, error } = await pollOnce(body);
    expect(error?.endpoint.path).toBe('/byok/events');
    expect(error?.status).toBe(200);
    expect(error?.cause).toMatchObject({ name: 'ZodError', issues: [expect.objectContaining({ path: issuePath })] });
    // Nothing from a rejected page is consumed, not even its valid entry.
    expect(onEnvelope).not.toHaveBeenCalled();
    expect(onValidationFailedSeq).not.toHaveBeenCalled();
    expect(onServerCapabilities).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['failure']);
  });

  it('keeps the client-local nonnegative cursor check: the schema admits a negative integer, the client refuses it', async () => {
    const { onEnvelope, outcomes, error } = await pollOnce({ events: [], cursor: -1, capabilities: [], ingress });
    expect(error?.status).toBe(200);
    expect((error?.cause as Error).message).toBe('events poll response.cursor is not a safe nonnegative integer');
    expect(onEnvelope).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['failure']);
  });

  it('keeps the client-local no-regression check: a page cursor below the requested cursor is refused', async () => {
    // First page advances navigation to 2 with read-ahead advertised; the next
    // page claims cursor 1, below the afterSeq=2 the client requested.
    const first = { events: [{ ...validOffer, seq: 2 }], cursor: 2, capabilities: ['mailbox-read-ahead'], ingress };
    const regressed = { events: [], cursor: 1, capabilities: ['mailbox-read-ahead'], ingress };
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      return jsonResponse(call === 1 ? first : regressed);
    });
    const onEnvelope = vi.fn();
    let loopFailures = 0;
    const client: LongPollClient = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => 1,
      onEnvelope,
      onLoopFailure: () => {
        loopFailures += 1;
        client.stop();
      },
      retryDelayMs: 20,
      idleDelayMs: 20,
    });
    client.start();
    await vi.waitFor(() => expect(loopFailures).toBe(1));
    client.stop();
    const requested = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(requested.searchParams.get('afterSeq')).toBe('2');
    const [error] = warnedRouteErrors();
    expect(error?.status).toBe(200);
    expect((error?.cause as Error).message).toBe('events poll response.cursor regressed below the requested cursor');
    expect(onEnvelope).toHaveBeenCalledTimes(1);
  });

  it('an unknown envelope inside a valid page still stalls only its own sequence, without a route failure', async () => {
    const unknownType = {
      v: PROTOCOL_VERSION,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff41',
      ts: new Date().toISOString(),
      type: 'task.some_future_type',
      task_id: 'future-task',
      seq: 1,
      payload: {},
    };
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      const capabilities = ['mailbox-read-ahead'];
      return jsonResponse(call === 1 ? { events: [unknownType], cursor: 1, capabilities, ingress } : { events: [], cursor: 1, capabilities, ingress });
    });
    const onEnvelope = vi.fn();
    const onValidationFailedSeq = vi.fn();
    const onLoopFailure = vi.fn();
    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => undefined,
      onEnvelope,
      onValidationFailedSeq,
      onLoopFailure,
      retryDelayMs: 20,
      idleDelayMs: 20,
    });
    client.start();
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    client.stop();
    expect(onValidationFailedSeq).toHaveBeenCalledWith(1);
    expect(onValidationFailedSeq).toHaveBeenCalledTimes(1);
    expect(onEnvelope).not.toHaveBeenCalled();
    expect(warnedRouteErrors()).toEqual([]);
    // The entry stalls its own sequence; the page itself was valid, so the loop goes on polling.
    expect(onLoopFailure).not.toHaveBeenCalled();
    expect((warnMock.mock.calls as unknown[][]).some((call) => String(call[0]).includes('unknown or invalid executable message at seq=1'))).toBe(true);
  });
});
