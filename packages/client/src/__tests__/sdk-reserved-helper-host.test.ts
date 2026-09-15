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

/**
 * Stands in for the allowlisted child environment `buildRuntimeEnv` produces
 * for the selected runtime — the preflight never sees `process.env` itself.
 */
const PROBE_BASE_ENV: Readonly<Record<string, string>> = { PATH: process.env.PATH ?? '' };

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
    for (const kind of ['agent-message-mcp', 'agent-memory-mcp', 'approval-mcp', 'agent-team-mcp', 'mcp-env'] as const) {
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
      let initialized = false;
      const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
      reader.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined || request.id === null) {
          if (request.method === 'notifications/initialized') initialized = true;
          return;
        }
        if (request.method === 'initialize') {
          reply(request.id, {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'byok-message-helper', version: '0.0.0' },
          });
          return;
        }
        if (request.method === 'tools/list' && initialized) {
          reply(request.id, {
            tools: [{ name: 'send_agent_message', description: '', inputSchema: { type: 'object' } }],
          });
        }
      });
    `);
    await expect(preflightAgentMessageMcp({
      command: process.execPath,
      args: [helper],
      env: { BYOK_STORE_DIR: '/tmp/store', BYOK_PRODUCT_ID: 'product', BYOK_AGENT_MESSAGE_CONTEXT: 'context' },
    }, PROBE_BASE_ENV)).resolves.toBeUndefined();

    const broken = await fixture('broken.mjs', `process.stderr.write('unknown command\\n'); process.exit(2);`);
    await expect(preflightAgentMessageMcp({ command: process.execPath, args: [broken] }, PROBE_BASE_ENV))
      .rejects.toThrow(/exited before.*unknown command/s);
  });

  it('admits an exact helper whose single-file startup exceeds the former three-second bound', async () => {
    const delayedHelper = await fixture('delayed-helper.mjs', `
      import { createInterface } from 'node:readline';
      const reader = createInterface({ input: process.stdin, terminal: false });
      let initialized = false;
      const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
      reader.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined || request.id === null) {
          if (request.method === 'notifications/initialized') initialized = true;
          return;
        }
        if (request.method === 'initialize') {
          reply(request.id, {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'byok-message-helper', version: '0.0.0' },
          });
          return;
        }
        if (request.method === 'tools/list' && initialized) {
          // Slower than the former three-second bound, on purpose.
          setTimeout(() => reply(request.id, {
            tools: [{ name: 'send_agent_message', description: '', inputSchema: { type: 'object' } }],
          }), 3250);
        }
      });
    `);

    await expect(preflightAgentMessageMcp({
      command: process.execPath,
      args: [delayedHelper],
    }, PROBE_BASE_ENV)).resolves.toBeUndefined();
  });
});
