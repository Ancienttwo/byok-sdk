import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEnvelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { startRealCloud, type RealCloudHandle } from './fixtures/real-cloud';

const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SALESKO_MCP_FIXTURE = fileURLToPath(new URL('./fixtures/fake-salesko-mcp.mjs', import.meta.url));

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('hosted Salesko MCP toolset over the real cloud transport', () => {
  let cloud: RealCloudHandle;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await cloud.close();
  });

  it('logical offer -> long-poll -> strict Claude MCP -> local connector -> terminal receipt', async () => {
    cloud = await startRealCloud({
      productId: 'salesko',
      longPollHoldMs: 200,
      longPollIntervalMs: 20,
    });

    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
    });
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Salesko Personal Agent',
        productId: 'salesko',
        serverUrl: cloud.url,
        workspaceRoot: await tmpDir('byok-hosted-salesko-mcp-workspace-'),
        storeDir: await tmpDir('byok-hosted-salesko-mcp-store-'),
        runtimeAllowlist: ['claude'],
        runtimePreference: ['claude'],
        // Disable every built-in Claude tool. MCP tools remain separately
        // projected from the task-scoped strict config.
        permissionDefaults: { mode: 'readonly', allowTools: [] },
        mcpToolsets: {
          'salesko.connectors': {
            mcpServers: {
              salesko: { command: process.execPath, args: [SALESKO_MCP_FIXTURE] },
            },
          },
        },
      },
      [adapter],
      {
        longPoll: {
          retryDelayMs: 20,
          idleDelayMs: 20,
        },
      },
    );

    const pairing = await cloud.createPairingCode();
    const device = await daemon.pair(pairing.code);
    await daemon.start();

    await vi.waitFor(async () => {
      const presence = await cloud.listPresence();
      expect(presence).toHaveLength(1);
      expect(presence[0]).toMatchObject({
        deviceId: device.deviceId,
        configuredToolsets: ['salesko.connectors'],
      });
      expect(JSON.stringify(presence)).not.toContain(SALESKO_MCP_FIXTURE);
    });

    const offer = await cloud.enqueueToolsetOffer(device.deviceId, {
      instruction: 'salesko:find-leads',
      policy: { mode: 'readonly', allowTools: [] },
      runtime: 'claude',
      requiredToolsets: ['salesko.connectors'],
    });
    expect(offer.envelope).toMatchObject({
      type: 'task.offer_with_toolsets',
      payload: { runtime: 'claude', requiredToolsets: ['salesko.connectors'] },
    });
    // The host sends logical ids only. Local commands remain device authority.
    expect(JSON.stringify(offer.envelope)).not.toContain(SALESKO_MCP_FIXTURE);

    await vi.waitFor(async () => {
      expect((await cloud.readTaskAttempt(offer.taskId))?.status).toBe('complete');
    }, { timeout: 10_000 });

    const terminalBody = await cloud.readTerminalBody(offer.taskId);
    expect(terminalBody).toBeDefined();
    expect(terminalBody).not.toContain(SALESKO_MCP_FIXTURE);
    const terminal = decodeEnvelope(terminalBody ?? '');
    expect(terminal).toMatchObject({ type: 'task.complete', task_id: offer.taskId });
    expect(JSON.stringify(terminal)).toContain('Ada Lead');
    expect(JSON.stringify(terminal)).toContain('salesko-fake');
    expect(JSON.stringify(await cloud.readActivity(offer.taskId))).toContain('mcp__salesko__find_leads');
  }, 15_000);
});
