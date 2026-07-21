import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { LongPollClient } from '../daemon/long-poll-transport';
import { DeviceStore } from '../daemon/store';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finding R1 (cross-model re-review — Codex's new P2 on the F1 fix): proves
 * `LongPollClient`'s OWN half of the fix — the local
 * `hadValidationFailureThisBatch` flag that makes the poll loop back off
 * (`retryDelayMs`) on the SAME cycle a validation-failed entry is first
 * discovered, rather than only from the NEXT cycle onward.
 *
 * DEVIATION FROM THE ORIGINAL "fake-timer assertion" ASK (documented, not
 * silent): `vi.useFakeTimers()` was tried first and reproducibly HUNG this
 * suite (confirmed twice, including after removing every `vi.waitFor` call
 * in favor of a hand-rolled bounded `advanceTimersByTimeAsync` poll) —
 * something in this vitest/Node combination's fake-timer implementation
 * does not play safely with this test's async chain (a mocked-`fetch`-driven
 * loop). Rather than keep sinking time into that one specific technique,
 * this uses REAL timers with fast, deterministic delays instead — the SAME
 * convention this codebase's own other backoff tests already establish
 * (see e.g. `daemon-reconnect.test.ts`'s `backoff: {baseMs: 20, maxMs:
 * 100}`) — and asserts on real (small, generously-margined) wall-clock
 * windows instead of a mocked clock. This proves the identical observable
 * property (no full-RTT-speed hot loop; the configured `retryDelayMs` is
 * actually honored) just via a different, working mechanism.
 *
 * Deliberately does NOT go through a real `TestServer`/`ConnectionManager`
 * either: `global.fetch` is mocked directly (no real network) and a tiny,
 * FAITHFUL stand-in for `ConnectionManager`'s relevant behavior is used —
 * `isStalled`/`onValidationFailedSeq` mirror `ConnectionManager
 * .noteValidationFailure`'s own defining property: the stall flag is set
 * via a MICROTASK (`Promise.resolve().then(...)`), never synchronously,
 * exactly the timing gap `noteValidationFailure`'s chaining onto
 * `processingChain` produces for the same reason (an earlier envelope in
 * the same batch may still be in flight on that FIFO chain; see its own
 * doc comment). A synchronous stand-in would NOT exercise the one-cycle
 * race this suite exists to catch — with a plain synchronous flag instead,
 * this test would still pass even with `hadValidationFailureThisBatch`
 * removed, which would defeat the point.
 *
 * The `ConnectionManager`-side contract itself (stall freezes the cursor,
 * holds back a later valid envelope in the same/a later batch, clears once
 * a corrected redelivery succeeds) is proven separately, end-to-end and for
 * real, in `unknown-message-type-tolerance.test.ts`'s own R1 tests.
 */
describe('LongPollClient: validation-failure backoff (finding R1, Codex P2)', () => {
  let auth: AuthManager;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const storeDir = await tmpDir('byok-lp-validation-stall-store-');
    const store = new DeviceStore(storeDir);
    await store.save({
      deviceId: 'dev-1',
      accessToken: 'tok-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), // far future — getValidAccessToken never renews, never touches the network
      devicePrivateKeyPem: 'unused-in-this-test',
      devicePublicKey: 'unused-in-this-test',
    });
    auth = new AuthManager({ serverUrl: 'http://example.invalid', store });
    await auth.loadExisting();

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown): Response {
    return { ok: true, json: async () => body } as Response;
  }

  it('backs off by retryDelayMs on the VERY SAME cycle a validation-failed entry is first discovered — no full-RTT-speed hot loop', async () => {
    const badKnownType = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff30',
      ts: new Date().toISOString(),
      type: 'task.offer', // recognized type ...
      task_id: 'bad-task',
      seq: 2,
      payload: {}, // ... but missing required fields -> EnvelopeValidationError
    };
    const validEnvelope = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff31',
      ts: new Date().toISOString(),
      type: 'task.offer',
      task_id: 'good-task',
      seq: 3,
      payload: { instruction: 'do it', policy: { mode: 'auto' } },
    };

    // Every poll returns the SAME [bad, valid] batch — matches the server's
    // real retain-and-redeliver semantics (protocol §9) for as long as the
    // cursor is frozen (nothing in this test ever "corrects" seq2).
    fetchMock.mockResolvedValue(jsonResponse({ events: [badKnownType, validEnvelope], cursor: 3 }));

    let stalledAtSeq: number | undefined;
    const onEnvelope = vi.fn();
    const onValidationFailedSeq = vi.fn((seq: number) => {
      // Mirrors ConnectionManager.noteValidationFailure's own defining
      // property: deferred via a microtask, never synchronous — see this
      // file's own module doc comment for why that's load-bearing here.
      void Promise.resolve().then(() => {
        if (stalledAtSeq === undefined) stalledAtSeq = seq;
      });
    });

    const retryDelayMs = 150;
    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => (stalledAtSeq !== undefined ? 1 : undefined),
      onEnvelope,
      onValidationFailedSeq,
      isStalled: () => stalledAtSeq !== undefined,
      retryDelayMs,
      idleDelayMs: 20,
    });

    client.start();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(onValidationFailedSeq).toHaveBeenCalledWith(2);
    expect(onValidationFailedSeq).toHaveBeenCalledTimes(1); // engaged once, not once per redelivery within this same cycle
    expect(onEnvelope).toHaveBeenCalledTimes(1); // the valid seq=3 entry WAS handed to onEnvelope despite the stall

    // The critical assertion: well under retryDelayMs later, the loop must
    // NOT have already gone back around for a second fetch — proving
    // `hadValidationFailureThisBatch` (not a synchronous read of
    // `isStalled()`, which would still read false at the exact instant the
    // failure is first discovered) is what triggers the backoff on THIS
    // very cycle, not merely from the next one onward.
    await delay(Math.floor(retryDelayMs * 0.4));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past retryDelayMs (generous margin) — the second cycle's fetch fires.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 5000 });

    client.stop();
  });

  it('a batch with ONLY unknown-type (forward-compat) entries never backs off at retryDelayMs — the existing idle/no-op cadence is unaffected', async () => {
    const unknownType = {
      v: 1,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffff32',
      ts: new Date().toISOString(),
      type: 'task.some_future_type',
      task_id: 'future-task',
      seq: 2,
      payload: {},
    };
    // Only the first TWO polls return the (non-empty, unknown-type-only)
    // batch under test; every poll after that returns empty, which
    // legitimately sleeps on `idleDelayMs` (pre-existing, unrelated
    // behavior) and stops the cycle from spinning at mocked-fetch speed
    // forever. Bounding it this way is a TEST-harness concern only: real
    // usage always has genuine network I/O pacing every cycle even on this
    // path (see this file's own module doc comment on why `global.fetch`
    // is mocked with zero real I/O here at all) — `getCursor` returning
    // `undefined` throughout also means this stand-in never actually
    // models the cursor advancing the way a real `ConnectionManager`
    // would; that full contract is proven for real, end-to-end, against a
    // genuine (if fast) `TestServer`, in
    // `unknown-message-type-tolerance.test.ts`'s own long-standing tests
    // (confirmed unaffected by finding R1 — see this suite's own module
    // doc comment).
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      return jsonResponse(call <= 2 ? { events: [unknownType], cursor: 2 } : { events: [], cursor: 2 });
    });

    const onSkippedSeq = vi.fn();
    const retryDelayMs = 2000; // deliberately large — if the (wrong) old behavior applied it here too, the assertion below would time out
    const client = new LongPollClient({
      serverUrl: 'http://example.invalid',
      auth,
      getCursor: () => undefined,
      onEnvelope: vi.fn(),
      onSkippedSeq,
      isStalled: () => false, // never stalled — a pure forward-compat skip never engages the stall
      retryDelayMs,
      idleDelayMs: 20,
    });

    client.start();
    // Real wall-clock window, deliberately short relative to retryDelayMs
    // (2000ms) but generous relative to idleDelayMs (20ms): a non-empty,
    // not-stalled batch must never gate behind the LARGE retryDelayMs, so
    // well over one call must have landed by now. (Not asserting an EXACT
    // count on purpose — the precise number depends on how many idle-cycle
    // empty polls fit in the window, which isn't this test's concern.)
    await delay(200);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onSkippedSeq).toHaveBeenCalledWith(2);

    client.stop();
  });
});
