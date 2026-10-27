import { testScratchOwner } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { TaskRunner } from '../daemon/task-runner';
import type { RuntimeAdapterPrepareInput, RuntimeAdapterPrepareResult } from '../types';
import { StubRuntimeAdapter, StubSession } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

/**
 * `task.decline` and `task.fail` leave this device. Agent-home errors name the
 * canonical home in their message, so a reason that forwards one must not
 * carry the local path. The host storage root has a space in its name, like
 * `~/Library/Application Support`, so a path is not cut at the first space.
 */

const AGENT = { agentId: 'outbound-agent', profileRevision: 'profile-1' } as const;

const roots: string[] = [];
async function temporary(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

const blobClient: BlobResolver = {
  resolveInstruction: async () => { throw new Error('not used'); },
  uploadArtifact: async () => { throw new Error('not used'); },
};

/** Starts a fresh Session with a fixed ref when `sessionRefOverride` is set. */
class FixedSessionAdapter extends StubRuntimeAdapter {
  sessionRefOverride: string | undefined;

  override async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    const base = await super.prepare(input);
    const sessionRef = this.sessionRefOverride;
    if (base.kind !== 'prepared' || sessionRef === undefined) return base;
    return {
      ...base,
      operation: {
        ...base.operation,
        start: async () => {
          const session = new StubSession(sessionRef);
          this.sessions.push(session);
          return session;
        },
      },
    };
  }
}

function readerOffer(taskId: string, seq: number, sessionRef?: string): Envelope {
  return createEnvelope('task.offer_for_agent', {
    instruction: 'outbound reason work',
    runtime: 'pi',
    agentRef: AGENT,
    homeAccess: 'memory-reader' as const,
    ...(sessionRef === undefined ? {} : { sessionRef }),
  }, { taskId, seq });
}

function reasonOf(sent: readonly Envelope[], type: 'task.decline' | 'task.fail', taskId: string): string {
  const envelope = sent.find((entry) => entry.type === type && entry.task_id === taskId);
  expect(envelope, `${type} for ${taskId}`).toBeDefined();
  return (envelope!.payload as { reason: string }).reason;
}

async function readerRunner(adapter: StubRuntimeAdapter): Promise<{
  runner: TaskRunner; sent: Envelope[]; hostStorageRoot: string; canonicalRoot: string;
}> {
  const storeDir = await temporary('byok-outbound-reason-store-');
  const hostStorageRoot = await temporary('byok outbound reason home-');
  const sent: Envelope[] = [];
  const runner = new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [adapter],
    agentHome: new AgentHomeManager({ hostStorageRoot }),
    agentSessionHandoffs: new AgentSessionHandoffStore(),
    deviceId: 'device-outbound-reason',
    send: (envelope) => sent.push(envelope),
    blobClient,
    approvalRegistry: new ApprovalRegistry(),
    storeDir,
    productId: 'outbound-reason',
  });
  return { runner, sent, hostStorageRoot, canonicalRoot: await fs.realpath(hostStorageRoot) };
}

function expectNoLocalPath(reason: string, roots: readonly string[]): void {
  for (const root of roots) expect(reason).not.toContain(root);
  expect(reason).not.toContain(path.basename(roots[0]!));
  expect(reason).not.toContain(os.tmpdir());
}

describe('Agent-home errors in outbound task reasons', () => {
  it('task.decline: a reader that resumes a Session another reader holds names no local path', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const { runner, sent, hostStorageRoot, canonicalRoot } = await readerRunner(adapter);

    await runner.handleEnvelope(readerOffer('reader-holder', 1));
    expect(sent.some((entry) => entry.type === 'task.started' && entry.task_id === 'reader-holder')).toBe(true);
    const heldSession = adapter.sessions[0]!.sessionRef;

    await runner.handleEnvelope(readerOffer('reader-resume', 2, heldSession));

    const reason = reasonOf(sent, 'task.decline', 'reader-resume');
    expect(reason).toBe('Agent home admission failed: Agent session already has an active execution lease in <local path>');
    expectNoLocalPath(reason, [hostStorageRoot, canonicalRoot]);
    const decline = sent.find((entry) => entry.type === 'task.decline' && entry.task_id === 'reader-resume')!;
    expect((decline.payload as { retryable: boolean }).retryable).toBe(true);
  });

  it('task.fail: a fresh reader whose runtime returns a held Session names no local path', async () => {
    const adapter = new FixedSessionAdapter('pi');
    const { runner, sent, hostStorageRoot, canonicalRoot } = await readerRunner(adapter);

    await runner.handleEnvelope(readerOffer('reader-holder', 1));
    expect(sent.some((entry) => entry.type === 'task.started' && entry.task_id === 'reader-holder')).toBe(true);
    adapter.sessionRefOverride = adapter.sessions[0]!.sessionRef;

    await runner.handleEnvelope(readerOffer('reader-collides', 2));

    const reason = reasonOf(sent, 'task.fail', 'reader-collides');
    expect(reason).toBe(
      'Agent session execution lease could not bind the runtime session: '
        + 'Agent session already has an active execution lease in <local path>',
    );
    expectNoLocalPath(reason, [hostStorageRoot, canonicalRoot]);
  });
});
