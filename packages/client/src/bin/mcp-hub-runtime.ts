import { isAbsolute } from 'node:path';
import { finished } from 'node:stream/promises';
import type { McpStdioServerSpec } from '../mcp/client.js';
import { serveMcpHub } from '../mcp/hub/index.js';
import { isJsonObject } from '../mcp/hub/protocol.js';
import { MCP_HUB_CONTEXT_ACTIVE_METHOD, readMcpContextFile, sdkReservedHelperArgumentCount, type McpHubContext } from '../sdk-reserved-helper-context.js';
import { connectControlClient, type ControlClient } from '../daemon/control-client.js';
import { sessionCredentialRedactor } from '../runtime/claude-session-runtime.js';

function isLaunchPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !value.includes('\u0000');
}

function isEnvironment(value: unknown): value is Record<string, string> {
  return isJsonObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isServerSpec(value: unknown): value is McpStdioServerSpec {
  return isJsonObject(value) && isLaunchPath(value.command)
    && (value.args === undefined || (Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string')))
    && (value.env === undefined || isEnvironment(value.env));
}

function isHubBinding(value: unknown): value is McpHubContext['binding'] {
  return isJsonObject(value) && typeof value.attemptId === 'string' && value.attemptId.length > 0
    && isLaunchPath(value.catalogPath) && isLaunchPath(value.launchCwd) && isEnvironment(value.mcpEnv)
    && isJsonObject(value.mcpServers) && Object.values(value.mcpServers).every(isServerSpec);
}

export async function runMcpHub(argv: readonly string[]): Promise<void> {
  if (argv.length !== sdkReservedHelperArgumentCount('mcp-hub')) {
    throw new Error('SDK-reserved task helpers take exactly one context file path');
  }
  const { storeDir, productId, contextToken, binding, innerNonces } = await readMcpContextFile(argv[0]!);
  if (!isHubBinding(binding)) throw new Error('MCP context file has an invalid hub binding');
  if (innerNonces !== undefined && (!Array.isArray(innerNonces) || innerNonces.some(nonce => typeof nonce !== 'string' || nonce.length === 0))) {
    throw new Error('MCP context file has invalid inner nonces');
  }
  const redactor = sessionCredentialRedactor({
    env: binding.mcpEnv,
    mcpServers: Object.entries(binding.mcpServers).map(([name, spec]) => ({ name, ...spec })),
  });
  redactor.add(contextToken);
  for (const nonce of innerNonces ?? []) redactor.add(nonce);

  let connection: Promise<ControlClient> | undefined;
  const hub = serveMcpHub({
    binding,
    async isActive(signal) {
      signal.throwIfAborted();
      const pending = connection ??= connectControlClient({ storeDir, productId }).then(result => {
        if (!result.ok) throw new Error('MCP hub control socket is unavailable');
        return result.client;
      });
      try {
        const client = await pending;
        if (signal.aborted) return false;
        return await client.request<boolean>(MCP_HUB_CONTEXT_ACTIVE_METHOD, { contextToken }) === true;
      } catch {
        if (connection === pending) connection = undefined;
        (await pending.catch(() => undefined))?.close();
        return false;
      }
    },
    containsPrivateValue: value => redactor.redactValue(value) !== value,
  });
  try {
    await finished(process.stdin, { cleanup: true });
  } finally {
    const closing = hub.close();
    (await connection?.catch(() => undefined))?.close();
    await closing;
  }
}
