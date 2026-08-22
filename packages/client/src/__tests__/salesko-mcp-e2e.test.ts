import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';

const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SALESKO_MCP_FIXTURE = fileURLToPath(new URL('./fixtures/fake-salesko-mcp.mjs', import.meta.url));

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used');
  },
  uploadArtifact: async () => {
    throw new Error('not used');
  },
};

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Salesko fake connector MCP end to end', () => {
  it('offer id -> local registry -> strict Claude config -> stdio MCP tool call -> terminal result', async () => {
    const sent: Envelope[] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
    });
    const deps: TaskRunnerDeps = {
      adapters: [adapter],
      runtimeAllowlist: ['claude'],
      workspaceRoot: await tmpDir('byok-salesko-e2e-workspace-'),
      deviceId: 'device-salesko',
      send: (envelope) => sent.push(envelope),
      blobClient: unusedBlobClient,
      sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-salesko-e2e-store-')),
      approvalRegistry: new ApprovalRegistry(),
      storeDir: 'unused-store-dir',
      productId: 'salesko',
      getMcpToolsets: () => new Map([
        [
          'salesko',
          {
            mcpServers: {
              salesko: { command: process.execPath, args: [SALESKO_MCP_FIXTURE] },
            },
          },
        ],
      ]),
    };
    const runner = new TaskRunner(deps);

    await runner.handleEnvelope(
      createEnvelope(
        'task.offer_with_toolsets',
        {
          instruction: 'salesko:find-leads',
          policy: { mode: 'auto' },
          runtime: 'claude',
          requiredToolsets: ['salesko'],
        },
        { taskId: 'task-salesko-e2e', seq: 1 },
      ),
    );

    await vi.waitFor(
      () => expect(sent.some((envelope) => envelope.type === 'task.complete')).toBe(true),
      { timeout: 5000 },
    );

    expect(sent.some((envelope) => envelope.type === 'task.claim')).toBe(true);
    expect(sent.some((envelope) => envelope.type === 'task.started')).toBe(true);
    expect(JSON.stringify(sent)).toContain('mcp__salesko__find_leads');
    expect(JSON.stringify(sent)).toContain('salesko-fake');
    const terminal = sent.find((envelope) => envelope.type === 'task.complete');
    expect(terminal?.payload).toMatchObject({ sessionRef: 'fake-claude-session-1' });
    expect(JSON.stringify(terminal)).toContain('Ada Lead');

    // Local executable authority is never echoed to the SaaS-side envelope stream.
    expect(JSON.stringify(sent)).not.toContain(SALESKO_MCP_FIXTURE);
  });
});
