import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { AGENT_MEMORY_GUIDANCE, prependAgentMemoryGuidance } from '../daemon/memory-guidance';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner } from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-memory-guidance-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('Agent memory guidance', () => {
  it('prepends the exact runtime-neutral guidance block', () => {
    const expected = [
      'At the start of this Agent task, first read `MEMORY.md` in the provided `cwd`.',
      'Treat `MEMORY.md` as a concise, self-contained recovery index; if it is empty, initialize a brief index from durable, non-secret task knowledge.',
      'Read files under `notes/` only as needed, following pointers from the index.',
      'When task permissions allow and a durable value is learned, update the relevant `notes/` entry and the `MEMORY.md` index.',
      'Never write credentials, secrets, tokens, API keys, private keys, or other authentication material to `MEMORY.md` or `notes/`.',
    ].join('\n');
    const instruction = 'perform the assigned work';

    expect(AGENT_MEMORY_GUIDANCE).toBe(expected);
    expect(prependAgentMemoryGuidance(instruction)).toBe(`${expected}\n\n${instruction}`);
  });

  it('injects guidance for strict Agent tasks only across the shared runtime seam', async () => {
    const hostStorageRoot = await makeRoot();
    const workspaceRoot = await makeRoot();
    const storeDir = await makeRoot();
    const runtimes = ['pi', 'claude', 'codex'] as const;
    const adapters = runtimes.map((runtime) => new StubRuntimeAdapter(runtime));
    const blobClient: BlobResolver = {
      resolveInstruction: async () => {
        throw new Error('not used in this test');
      },
      uploadArtifact: async () => {
        throw new Error('not used in this test');
      },
    };
    const runner = new TaskRunner({
      adapters,
      workspaceRoot,
      agentHome: new AgentHomeManager({ hostStorageRoot }),
      agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'device-memory-guidance',
      send: () => {},
      blobClient,
      sessionWorkspaces: new SessionWorkspaceStore(storeDir),
      approvalRegistry: new ApprovalRegistry(),
      storeDir,
      productId: 'product-memory-guidance',
    });

    let seq = 1;
    for (const runtime of runtimes) {
      await runner.handleEnvelope(
        createEnvelope(
          'task.offer_for_agent',
          {
            instruction: `agent instruction for ${runtime}`,
            policy: { mode: 'auto' },
            runtime,
            agentRef: { agentId: `agent-${runtime}`, profileRevision: 'profile-1' },
          },
          { taskId: `agent-task-${runtime}`, seq: seq++ },
        ),
      );
    }

    for (const runtime of runtimes) {
      await runner.handleEnvelope(
        createEnvelope(
          'task.offer',
          {
            instruction: `ordinary instruction for ${runtime}`,
            policy: { mode: 'auto' },
            runtime,
          },
          { taskId: `ordinary-task-${runtime}`, seq: seq++ },
        ),
      );
    }

    for (const [index, runtime] of runtimes.entries()) {
      const adapter = adapters[index]!;
      expect(adapter.startCalls[0]?.task.instruction).toBe(
        prependAgentMemoryGuidance(`agent instruction for ${runtime}`),
      );
      expect(adapter.startCalls[1]?.task.instruction).toBe(`ordinary instruction for ${runtime}`);
    }

    for (const adapter of adapters) {
      for (const session of adapter.sessions) session.emit({ type: 'turn_end' });
    }
    await vi.waitFor(() => expect(runner.activeTaskCount).toBe(0));
  });
});
