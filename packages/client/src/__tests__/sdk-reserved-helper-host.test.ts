import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BYOK_SDK_HELPER_SUBCOMMAND,
  resolveSdkReservedHelperBin,
  runSdkReservedHelperCommand,
} from '../sdk-reserved-helper-host';
import { preflightAgentMessageMcp } from '../daemon/agent-message-mcp-preflight';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function fixture(name: string, source: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sdk-helper-'));
  roots.push(root);
  const file = path.join(root, name);
  await fs.writeFile(file, source, 'utf8');
  return file;
}

describe('SDK-reserved helper host composition', () => {
  it('keeps normal product argv untouched and resolves one explicit self-executable shape for all helpers', async () => {
    await expect(runSdkReservedHelperCommand(['status'])).resolves.toBe(false);
    await expect(runSdkReservedHelperCommand([BYOK_SDK_HELPER_SUBCOMMAND, 'unknown'])).rejects.toThrow(/invalid/);
    for (const kind of ['agent-message-mcp', 'agent-memory-mcp', 'approval-mcp'] as const) {
      expect(resolveSdkReservedHelperBin(kind, { mode: 'self-executable', executable: '/product/salesko-agent' }))
        .toEqual({
          command: '/product/salesko-agent',
          args: [BYOK_SDK_HELPER_SUBCOMMAND, kind],
          source: 'self-executable',
        });
    }
    expect(() => resolveSdkReservedHelperBin('agent-message-mcp', {
      mode: 'self-executable', executable: 'relative-product',
    })).toThrow(/absolute executable path/);
  });

  it('handshakes the exact message helper command before runtime admission', async () => {
    const helper = await fixture('helper.mjs', `
      import { createInterface } from 'node:readline';
      const reader = createInterface({ input: process.stdin, terminal: false });
      reader.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.id === 1) console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        if (request.id === 2) console.log(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'send_agent_message' }] } }));
      });
    `);
    await expect(preflightAgentMessageMcp({
      command: process.execPath,
      args: [helper],
      env: { BYOK_STORE_DIR: '/tmp/store', BYOK_PRODUCT_ID: 'product', BYOK_AGENT_MESSAGE_CONTEXT: 'context' },
    })).resolves.toBeUndefined();

    const broken = await fixture('broken.mjs', `process.stderr.write('unknown command\\n'); process.exit(2);`);
    await expect(preflightAgentMessageMcp({ command: process.execPath, args: [broken] }))
      .rejects.toThrow(/exited before handshake.*unknown command/);
  });
});
