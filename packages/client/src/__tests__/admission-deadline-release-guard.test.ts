import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/**
 * The deadline-release semantics that `admission-deadline.test.ts` can only
 * observe indirectly through a whole daemon, proven here against ONE real
 * `TaskRunner` with no transport, no long-poll and no second budget in play.
 *
 * The property: a pre-claim decline of `runtime startup deadline exceeded`
 * must give the canonical Agent home's reservation back, so the very next
 * offer for the SAME home is admitted rather than declined `agent home busy`.
 * Two facts make that observable here and nowhere else:
 *
 * - The runner holds `deps` BY REFERENCE (`task-runner.ts:1355`,
 *   `constructor(private readonly deps: TaskRunnerDeps) {}`) and re-reads
 *   `this.deps.startupTimeoutMs` per offer (`task-runner.ts:1970`/`:1972`),
 *   so the test can arm a tight deadline for the first offer and a wide one
 *   for the replacement WITHOUT rebuilding the runner. Same runner, same
 *   private `homeReservations` map, same `AgentHomeExecutionLeaseManager` —
 *   a rebuild would erase exactly the state under test.
 * - `releaseReservation()` runs in `handleOffer`'s `finally`
 *   (`task-runner.ts:3085`), i.e. before this call returns and therefore
 *   before the replacement is handed in. Skipping it is what this guard
 *   goes red on.
 *
 * The replacement's admission is awaited as a settled `handleEnvelope` call,
 * never as elapsed wall clock: no test here sleeps, and the only two time
 * values are the two named constants below.
 */

/**
 * Attempt 1's startup budget. Small enough that the hung adapter phase is
 * withdrawn promptly; this bounds the PRODUCT's abort timer, not a test wait.
 */
const DEADLINE_MS = 250;
/**
 * Attempt 2's startup budget. Widens only the test's observation window for
 * the replacement — it asserts nothing about how fast admission must be, and
 * no product default depends on it.
 */
const WIDE_STARTUP_TIMEOUT_MS = 5_000;

/** Exact pre-claim decline reason set by `admissionWithdrawn` (`task-runner.ts:2831`). */
const DEADLINE_DECLINE_REASON = 'runtime startup deadline exceeded';
/** Exact prefix of the per-home busy decline (`task-runner.ts:2053`). */
const AGENT_HOME_BUSY_PREFIX = 'agent home busy';

const AGENT_REF = { agentId: 'deadline-release-agent', profileRevision: 'profile-1' } as const;

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-deadline-release-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used'); },
  uploadArtifact: async () => { throw new Error('not used'); },
};

function offerFor(taskId: string, seq: number): Envelope {
  return createEnvelope(
    'task.offer_for_agent',
    { instruction: 'work', policy: { mode: 'auto' }, runtime: 'pi', agentRef: AGENT_REF },
    { taskId, seq },
  );
}

function declinesFor(sent: readonly Envelope[], taskId: string) {
  return sent.filter((entry) => entry.type === 'task.decline' && entry.task_id === taskId);
}

describe('a startup-deadline decline hands the canonical Agent home back to the next offer', () => {
  for (const phase of ['detect', 'prepare'] as const) {
    it(`${phase}: the replacement on the same runner is admitted, never declined busy`, async () => {
      const hostStorageRoot = await makeRoot();
      const storeDir = await makeRoot();
      const workspaceRoot = await makeRoot();
      const adapter = new StubRuntimeAdapter('pi');
      const agentHome = new AgentHomeManager({ hostStorageRoot });
      const sent: Envelope[] = [];

      // Held by the test and mutated in place between the two offers; the
      // runner re-reads `startupTimeoutMs` off this exact object per offer.
      const deps: TaskRunnerDeps = {
        adapters: [adapter],
        workspaceRoot,
        agentHome,
        agentSessionHandoffs: new AgentSessionHandoffStore(),
        deviceId: 'device-deadline-release',
        send: (envelope) => sent.push(envelope),
        blobClient: unusedBlobClient,
        sessionWorkspaces: new SessionWorkspaceStore(storeDir),
        approvalRegistry: new ApprovalRegistry(),
        storeDir,
        productId: 'deadline-release-guard',
        startupTimeoutMs: DEADLINE_MS,
      };
      const runner = new TaskRunner(deps);

      let hang = true;
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const originalDetect = adapter.detect.bind(adapter);
      const originalPrepare = adapter.prepare.bind(adapter);
      vi.spyOn(adapter, 'detect').mockImplementation(async () => {
        if (hang && phase === 'detect') { entered = true; await gate; }
        return originalDetect();
      });
      vi.spyOn(adapter, 'prepare').mockImplementation(async (input) => {
        if (hang && phase === 'prepare') { entered = true; await gate; }
        return originalPrepare(input);
      });

      // Attempt 1 — reserved the home at `task-runner.ts:2057`, then hangs in
      // `phase` until the product's own abort timer withdraws admission.
      await runner.handleEnvelope(offerFor('blocked', 1));
      expect(entered).toBe(true);
      expect(declinesFor(sent, 'blocked')).toHaveLength(1);
      expect(declinesFor(sent, 'blocked')[0]!.payload).toEqual({
        reason: DEADLINE_DECLINE_REASON,
        retryable: true,
        agentRef: AGENT_REF,
      });
      expect(sent.some((entry) => entry.type === 'task.claim')).toBe(false);
      expect(adapter.startCalls).toHaveLength(0);
      // Nothing was ever admitted, so no execution lease exists to release.
      expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 0, attempts: 0 });

      // Attempt 2 — SAME runner, SAME deps object, SAME home. Only the
      // startup budget changes, and it changes on the object the runner holds.
      hang = false;
      deps.startupTimeoutMs = WIDE_STARTUP_TIMEOUT_MS;
      await runner.handleEnvelope(offerFor('replacement', 2));

      expect(declinesFor(sent, 'replacement')).toEqual([]);
      expect(sent.some((entry) => entry.type === 'task.claim' && entry.task_id === 'replacement')).toBe(true);
      expect(sent.some((entry) => entry.type === 'task.started' && entry.task_id === 'replacement')).toBe(true);
      expect(adapter.startCalls).toHaveLength(1);
      // The exact reason attempt 2 would carry if attempt 1's reservation had
      // leaked, named so a regression reads as itself rather than as a timeout.
      expect(sent.filter((entry) => entry.type === 'task.decline'
        && entry.payload.reason.startsWith(AGENT_HOME_BUSY_PREFIX))).toEqual([]);
      // Exactly what ONE admitted attempt implies: one home, one attempt.
      expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 1, attempts: 1 });

      // Late results from the retired admission path continue nothing.
      const beforeLate = sent.length;
      release();
      await gate;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent.slice(beforeLate).filter((entry) => entry.task_id === 'blocked')).toEqual([]);
      expect(adapter.startCalls).toHaveLength(1);
      expect(agentHome.executionLeaseManager.activeAttemptSummary()).toEqual({ homes: 1, attempts: 1 });

      adapter.sessions[0]!.emit({ type: 'turn_end' });
      await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
    });
  }
});
