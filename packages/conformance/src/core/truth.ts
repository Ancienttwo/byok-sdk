/**
 * Truth conformance (§12.3, §12.6.4).
 *
 * Terminal records are the one place in the system where "first write wins" is
 * a correctness requirement rather than a convenience: a retried terminal must
 * return the original fact, and a *different* terminal for the same task must
 * be refused with that fact attached — never overwritten, never merged.
 */
import { describe, expect, it } from 'vitest';
import { isCoreConflictError, type CoreConflictError, type TruthRecord } from '@byok-sdk/core';
import { hashOf, TENANT_A } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

export function runTruthConformance(factory: CoreCompositionFactory): void {
  describe('truth', () => {
    it('keeps the first terminal record and replays it for the same hash', async () => {
      await withComposition(factory, async ({ stores }) => {
        const first = await stores.truth.writeTerminal(TENANT_A, {
          taskId: 'task-1',
          contentHash: hashOf(1),
          byteSize: 120n,
          body: { kind: 'object', hash: hashOf(1) },
          requestId: 'req-1',
        });

        const replay = await stores.truth.writeTerminal(TENANT_A, {
          taskId: 'task-1',
          contentHash: hashOf(1),
          byteSize: 120n,
          body: { kind: 'object', hash: hashOf(1) },
          requestId: 'req-2',
        });

        expect(replay.rev).toBe(first.rev);
        expect(replay.writtenAt).toBe(first.writtenAt);
        expect(replay.requestId).toBe('req-1');
      });
    });

    it('refuses a different terminal hash and returns the committed record', async () => {
      await withComposition(factory, async ({ stores }) => {
        const first = await stores.truth.writeTerminal(TENANT_A, {
          taskId: 'task-1',
          contentHash: hashOf(1),
          byteSize: 120n,
          body: { kind: 'object', hash: hashOf(1) },
        });

        const conflict = await captureError(
          stores.truth.writeTerminal(TENANT_A, {
            taskId: 'task-1',
            contentHash: hashOf(2),
            byteSize: 130n,
            body: { kind: 'object', hash: hashOf(2) },
          }),
        );

        expect(isCoreConflictError(conflict, 'terminal_conflict')).toBe(true);
        const current = (conflict as CoreConflictError<TruthRecord>).current;
        expect(current.contentHash).toBe(first.contentHash);

        const stored = await stores.truth.getRecord(TENANT_A, {
          kind: 'task.terminal',
          recordKey: 'task-1',
        });
        expect(stored?.contentHash).toBe(hashOf(1));
      });
    });

    it('applies expectedRev CAS to profile and memory snapshots', async () => {
      await withComposition(factory, async ({ stores }) => {
        for (const kind of ['profile', 'memory'] as const) {
          const created = await stores.truth.writeSnapshot(TENANT_A, {
            kind,
            recordKey: 'primary',
            expectedRev: 0,
            contentHash: hashOf(10),
            byteSize: 10n,
            body: { kind: 'inline', body: '{}' },
          });
          expect(created.rev).toBe(1);

          const stale = await captureError(
            stores.truth.writeSnapshot(TENANT_A, {
              kind,
              recordKey: 'primary',
              expectedRev: 0,
              contentHash: hashOf(11),
              byteSize: 11n,
              body: { kind: 'inline', body: '{"a":1}' },
            }),
          );
          expect(isCoreConflictError(stale, 'truth_revision_conflict')).toBe(true);
          const current = (stale as CoreConflictError<TruthRecord | undefined>).current;
          expect(current?.rev).toBe(1);
          expect(current?.contentHash).toBe(hashOf(10));

          const updated = await stores.truth.writeSnapshot(TENANT_A, {
            kind,
            recordKey: 'primary',
            expectedRev: 1,
            contentHash: hashOf(11),
            byteSize: 11n,
            body: { kind: 'inline', body: '{"a":1}' },
          });
          expect(updated.rev).toBe(2);
        }
      });
    });

    it('rejects a create that claims an existing revision', async () => {
      await withComposition(factory, async ({ stores }) => {
        const conflict = await captureError(
          stores.truth.writeSnapshot(TENANT_A, {
            kind: 'profile',
            recordKey: 'absent',
            expectedRev: 3,
            contentHash: hashOf(12),
            byteSize: 12n,
            body: { kind: 'inline', body: '{}' },
          }),
        );
        expect(isCoreConflictError(conflict, 'truth_revision_conflict')).toBe(true);
        // No record exists, so the snapshot the caller lost to is "nothing".
        expect((conflict as CoreConflictError<TruthRecord | undefined>).current).toBeUndefined();
      });
    });

    it('returns manifest metadata without bodies', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.truth.writeSnapshot(TENANT_A, {
          kind: 'memory',
          recordKey: 'notes/one',
          expectedRev: 0,
          contentHash: hashOf(20),
          byteSize: 20n,
          body: { kind: 'inline', body: 'secret-body' },
          label: 'notes',
        });
        await stores.truth.writeSnapshot(TENANT_A, {
          kind: 'memory',
          recordKey: 'other/two',
          expectedRev: 0,
          contentHash: hashOf(21),
          byteSize: 21n,
          body: { kind: 'inline', body: 'other-body' },
        });

        const manifest = await stores.truth.listManifest(TENANT_A, {
          kind: 'memory',
          keyPrefix: 'notes/',
        });
        expect(manifest).toHaveLength(1);
        const entry = manifest[0]!;
        expect(entry.recordKey).toBe('notes/one');
        expect(entry.contentHash).toBe(hashOf(20));
        // Metadata only: deciding which bodies to fetch is a local decision (§S6.4).
        expect(Object.keys(entry)).not.toContain('body');
      });
    });
  });
}
