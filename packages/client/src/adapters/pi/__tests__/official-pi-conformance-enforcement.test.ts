/**
 * Official Pi 0.87.1 conformance — enforcement and determinism: D drift (c),
 * upstream ignoring the injected fetch (d), determinism knobs (e) and a
 * usage-absent stream (f). Synthetic SSE only; the only socket ever opened is
 * the refused connection to the non-routable sink in (d).
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { mapPiMessageToAgentEvent } from '../events';
import {
  byteLength,
  compileA1,
  compileWithoutInjectedFetch,
  COMPILE_OPTIONS,
  createOfficialSession,
  hostTranscript,
  installGlobalFetchSpy,
  sha256,
  SINK_HOST,
  textResponse,
  TRIGGER_TEXT,
  type GlobalFetchSpy,
  type RunScopedRefusal,
} from './official-pi-fixture';

const TIMEOUT_MS = 30_000;

let globalFetch: GlobalFetchSpy | undefined;
afterEach(() => {
  globalFetch?.restore();
  globalFetch = undefined;
});

function gateAgainst(frozenD: string, respond: () => Response) {
  return (sequence: number, body: string): Response | { refuse: RunScopedRefusal } => body === frozenD
    ? respond()
    : {
        refuse: {
          code: 'prepared_request_bytes_mismatch',
          sequence,
          expectedSha256: sha256(frozenD),
          observedSha256: sha256(body),
          observedBytes: byteLength(body),
        },
      };
}

describe('official Pi 0.87.1: final byte gate', () => {
  test('(c) D drift: one injected-fetch call, zero sends, prompt resolves, run-scoped typed reason, no retry', async () => {
    globalFetch = installGlobalFetchSpy();
    const frozen = await compileA1(hostTranscript());
    const frozenD = frozen.body;
    if (frozenD === undefined) throw new Error('A1\' compile captured no body');

    const harness = await createOfficialSession({
      transcript: () => hostTranscript(undefined, 'INPUT DOCUMENT: drifted after freeze'),
      gate: gateAgainst(frozenD, () => textResponse('must never be sent', true)),
    });
    try {
      await expect(harness.session.prompt(TRIGGER_TEXT)).resolves.toBeUndefined();
      expect(harness.gateBodies).toHaveLength(1);
      expect(harness.sends).toHaveLength(0);
      expect(harness.run.refusal).toEqual({
        code: 'prepared_request_bytes_mismatch',
        sequence: 1,
        expectedSha256: sha256(frozenD),
        observedSha256: sha256(harness.gateBodies[0]!),
        observedBytes: byteLength(harness.gateBodies[0]!),
      });
      expect(harness.run.refusal?.observedSha256).not.toBe(harness.run.refusal?.expectedSha256);

      // Both retry layers are off: after everything the prompt scheduled has
      // settled, the provider was still reached exactly once.
      await harness.session.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(harness.gateBodies).toHaveLength(1);
      expect(harness.providerOptions).toHaveLength(1);
      expect(harness.providerOptions[0]?.maxRetries).toBe(0);
      const last = harness.messageEnds.at(-1) as AssistantMessage | undefined;
      expect(last?.role).toBe('assistant');
      expect(last?.stopReason).toBe('error');
      expect(globalFetch.calls).toEqual([]);
    } finally {
      harness.dispose();
    }
  }, TIMEOUT_MS);
});

describe('official Pi 0.87.1: transport scoping', () => {
  test('(d) upstream ignoring the injected fetch reaches only the sink, is refused, and yields no D', async () => {
    globalFetch = installGlobalFetchSpy(true);
    const terminal = await compileWithoutInjectedFetch(hostTranscript());
    expect(terminal?.type).toBe('error');
    expect(terminal?.stopReason).toBe('error');
    expect(terminal?.errorMessage ?? '').toMatch(/connect|connection|refused|ECONNREFUSED|fetch failed|Unable to connect/i);
    // No D exists: there was no capture seam. Every global transport attempt
    // targeted the sink host and nothing else.
    for (const url of globalFetch.calls) expect(new URL(url).host).toBe(SINK_HOST);
    console.info('[conformance d] global transport calls', JSON.stringify(globalFetch.calls), 'error', terminal?.errorMessage);
  }, 10_000);
});

describe('official Pi 0.87.1: determinism knobs', () => {
  test('(e) PI_CACHE_RETENTION changes D unless cacheRetention is pinned; pinned D is identical', async () => {
    globalFetch = installGlobalFetchSpy();
    const previous = process.env.PI_CACHE_RETENTION;
    const unpinned = { reasoning: COMPILE_OPTIONS.reasoning, sessionId: COMPILE_OPTIONS.sessionId };
    try {
      process.env.PI_CACHE_RETENTION = 'long';
      const longUnpinned = await compileA1(hostTranscript(), unpinned);
      const longPinned = await compileA1(hostTranscript(), COMPILE_OPTIONS);
      process.env.PI_CACHE_RETENTION = 'short';
      const shortUnpinned = await compileA1(hostTranscript(), unpinned);
      const shortPinned = await compileA1(hostTranscript(), COMPILE_OPTIONS);

      for (const result of [longUnpinned, longPinned, shortUnpinned, shortPinned]) expect(result.fetchCalls).toBe(1);
      expect(longUnpinned.body).not.toBe(shortUnpinned.body);
      expect(longPinned.body).toBe(shortPinned.body);
      const drift = JSON.parse(longUnpinned.body!) as Record<string, unknown>;
      expect(drift.prompt_cache_key).toBe(COMPILE_OPTIONS.sessionId);
      expect(drift.prompt_cache_retention).toBe('24h');
      console.info('[conformance e] long-unpinned', byteLength(longUnpinned.body!), sha256(longUnpinned.body!),
        'short-unpinned', byteLength(shortUnpinned.body!), sha256(shortUnpinned.body!),
        'pinned', byteLength(longPinned.body!), sha256(longPinned.body!));
    } finally {
      if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = previous;
    }
    expect(globalFetch.calls).toEqual([]);
  });
});

describe('official Pi 0.87.1: usage observation', () => {
  test('(f) usage-absent SSE leaves all-zero usage, which the SDK maps to a zero prompt (usage_unavailable input)', async () => {
    globalFetch = installGlobalFetchSpy();
    const frozenD = (await compileA1(hostTranscript())).body;
    if (frozenD === undefined) throw new Error('A1\' compile captured no body');
    const harness = await createOfficialSession({
      transcript: () => hostTranscript(),
      gate: gateAgainst(frozenD, () => textResponse('answer without usage', false)),
    });
    try {
      await harness.session.prompt(TRIGGER_TEXT);
      expect(harness.gateBodies).toEqual([frozenD]);
      expect(harness.sends).toHaveLength(1);
      const assistant = harness.messageEnds.filter((message) => message.role === 'assistant') as AssistantMessage[];
      expect(assistant).toHaveLength(1);
      expect(assistant[0]!.stopReason).toBe('stop');
      expect(assistant[0]!.usage).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });

      // The SDK's usage projection (`adapters/pi/events.ts` mapPiAssistantUsage
      // via the exported mapPiMessageToAgentEvent) turns it into a zero prompt;
      // `daemon/task-runner.ts` observePreparedCall classifies any prompt <= 0
      // as `usage_unavailable` (covered end-to-end by prepared-offer-lane.test.ts).
      const event = mapPiMessageToAgentEvent({ type: 'message_end', message: assistant[0] } as never);
      expect(event).toEqual({ type: 'usage', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 });
      expect(globalFetch.calls).toEqual([]);
    } finally {
      harness.dispose();
    }
  }, TIMEOUT_MS);
});
