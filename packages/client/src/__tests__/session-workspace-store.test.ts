import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWorkspaceStore, type SessionWorkspaceRecord } from '../daemon/session-workspace-store';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Regression coverage for the resume-loses-workspace race (root cause behind
 * the intermittent `daemon-session-resume.test.ts` failures): `record()` is
 * deliberately fired-and-forgotten from `task-runner.ts`'s `handleOffer`
 * (`void this.deps.sessionWorkspaces.record(...).catch(() => {})`, never
 * awaited by design), so any number of `record()` calls for different
 * sessions can be in flight on the daemon's single shared
 * `SessionWorkspaceStore` instance at the exact moment a concurrent
 * `task.offer`'s `get()` lookup runs.
 *
 * Before the fix, `save()` was a bare, non-atomic `fs.writeFile` and
 * `get()`/`record()` had no serialization between them at all, so two
 * failure modes were both live:
 *  - a `get()` could `fs.readFile` a file mid-`writeFile` (truncated, then
 *    being rewritten), fail `JSON.parse`, and silently fall back to `{}`
 *    (see `load()`'s catch) — turning an already-recorded resume into a
 *    fresh workspace, silently.
 *  - two overlapping `record()` calls could each `load()` the same
 *    on-disk snapshot and `save()` back-to-back, silently losing whichever
 *    one lost the race (lost update).
 *
 * These tests hammer a real `SessionWorkspaceStore` against a real
 * temp-dir file with genuine concurrency (real disk I/O, no mocked timers,
 * no artificial delays) — the exact conditions the pre-fix implementation
 * could tear or drop under, and the fixed one (atomic rename + a per-store
 * serial queue) must handle deterministically every time.
 */
describe('SessionWorkspaceStore concurrency (atomic write + serialized queue)', () => {
  let storeDir: string;

  afterEach(async () => {
    if (storeDir) await fs.rm(storeDir, { recursive: true, force: true });
  });

  it('N concurrent record() calls for N distinct sessionRefs are all durably retrievable afterward — no lost update across interleaved load-modify-save cycles', async () => {
    storeDir = await tmpDir('byok-session-workspace-store-');
    const store = new SessionWorkspaceStore(storeDir);
    const N = 100;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.record(`session-${i}`, { workspaceDir: `/ws/${i}`, runtimeSessionId: `rt-${i}` }),
      ),
    );

    const results = await Promise.all(Array.from({ length: N }, (_, i) => store.get(`session-${i}`)));
    for (let i = 0; i < N; i++) {
      expect(results[i]).toEqual({ workspaceDir: `/ws/${i}`, runtimeSessionId: `rt-${i}` });
    }
  });

  it('concurrent record() calls to the SAME sessionRef never interleave a torn write — the serial queue applies them in call order and the final state is exactly the last one enqueued', async () => {
    storeDir = await tmpDir('byok-session-workspace-store-');
    const store = new SessionWorkspaceStore(storeDir);
    const N = 100;
    const sessionRef = 'resumed-session';

    // Fired synchronously in a tight loop (no `await` between calls), so
    // every one of these is enqueued back-to-back in exactly this call
    // order before any of their internal load()/save() work has actually
    // run — the scenario a shared mutex must serialize correctly.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.record(sessionRef, { workspaceDir: `/ws/${i}`, runtimeSessionId: `rt-${i}` }),
      ),
    );

    const finalValue = await store.get(sessionRef);
    expect(finalValue).toEqual({ workspaceDir: `/ws/${N - 1}`, runtimeSessionId: `rt-${N - 1}` });
  });

  it('a get() from an INDEPENDENT store instance, racing a storm of unrelated concurrent record() calls on another instance sharing the same storeDir, always sees the fully-recorded value once record() has resolved — never a torn read silently downgraded to undefined', async () => {
    storeDir = await tmpDir('byok-session-workspace-store-');
    // Two independent instances over the same on-disk file, mirroring
    // `daemon-session-resume.test.ts`'s own `storeView` pattern (a
    // TaskRunner's real store vs. a test's separate read-only handle) —
    // `reader` does NOT share `writer`'s in-process serial queue, so the
    // only thing that can protect it from a torn read is `save()`'s atomic
    // rename.
    const writer = new SessionWorkspaceStore(storeDir);
    const reader = new SessionWorkspaceStore(storeDir);

    const targetRef = 'the-one-we-check';
    const target: SessionWorkspaceRecord = { workspaceDir: '/ws/target', runtimeSessionId: 'rt-target' };

    await writer.record(targetRef, target);

    // Hammer the SAME file with a large burst of unrelated concurrent
    // writes from `writer` (no await between them) — this is what actually
    // produces overlapping load()/save() disk I/O concurrent with
    // `reader.get()` below.
    const burst = Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        writer.record(`noise-${i}`, { workspaceDir: `/ws/noise-${i}`, runtimeSessionId: `rt-noise-${i}` }),
      ),
    );

    // Fire many concurrent reads from the independent instance while the
    // burst above is still in flight.
    const reads = await Promise.all(Array.from({ length: 200 }, () => reader.get(targetRef)));
    await burst;

    for (const result of reads) {
      // Never `undefined` (the pre-fix torn-read failure mode: a
      // half-written file fails JSON.parse and load() falls back to `{}`)
      // and never anything other than the exact value already durably
      // recorded.
      expect(result).toEqual(target);
    }

    // The noise itself must all still be present afterward too — proves
    // the burst didn't lose updates against each other either.
    const noiseResults = await Promise.all(Array.from({ length: 200 }, (_, i) => writer.get(`noise-${i}`)));
    for (let i = 0; i < 200; i++) {
      expect(noiseResults[i]).toEqual({ workspaceDir: `/ws/noise-${i}`, runtimeSessionId: `rt-noise-${i}` });
    }
  });

  it('mirrors the real task-runner.ts shape: record() fired-and-forgotten (void ...record().catch(()=>{})) racing an awaited get() for a different, already-known sessionRef — the resume lookup is never affected by an in-flight unrelated write', async () => {
    storeDir = await tmpDir('byok-session-workspace-store-');
    const store = new SessionWorkspaceStore(storeDir);

    const knownRef = 'known-resume-target';
    const knownValue: SessionWorkspaceRecord = { workspaceDir: '/ws/known', runtimeSessionId: 'rt-known' };
    await store.record(knownRef, knownValue);

    const resumeLookups: Array<Promise<SessionWorkspaceRecord | undefined>> = [];
    for (let i = 0; i < 50; i++) {
      // Exactly task-runner.ts's own call-site pattern: not awaited, errors
      // swallowed (see handleOffer's `record()` call).
      void store.record(`fired-and-forgotten-${i}`, { workspaceDir: `/ws/faf-${i}`, runtimeSessionId: `rt-faf-${i}` }).catch(() => {});
      // The resume lookup a concurrent task.offer would make, awaited
      // exactly like handleOffer's `get()` call — fired every iteration so
      // several land while fire-and-forgotten record()s above are still
      // in flight.
      resumeLookups.push(store.get(knownRef));
    }

    const resumed = await Promise.all(resumeLookups);
    for (const value of resumed) {
      expect(value).toEqual(knownValue);
    }
  });

  it('preserves additive Git fields and treats omitted fields as legacy plain records', async () => {
    storeDir = await tmpDir('byok-session-workspace-store-');
    const store = new SessionWorkspaceStore(storeDir);
    await store.record('plain', { workspaceDir: '/plain', runtimeSessionId: 'runtime-plain' });
    await store.record('git', { workspaceDir: '/git', runtimeSessionId: 'runtime-git', workspaceKind: 'git', gitWorkspaceId: 'opaque-id' });
    expect(await store.get('plain')).toEqual({ workspaceDir: '/plain', runtimeSessionId: 'runtime-plain' });
    expect(await store.get('git')).toEqual({ workspaceDir: '/git', runtimeSessionId: 'runtime-git', workspaceKind: 'git', gitWorkspaceId: 'opaque-id' });
  });
});
