import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { finished } from 'node:stream/promises';
import type { McpStdioServerSpec } from '../mcp/client.js';
import { serveMcpHub } from '../mcp/hub/index.js';
import { HUB_CALL_TOOL, MCP_HUB_SERVER_NAME, isJsonObject } from '../mcp/hub/protocol.js';
import { qualifiedMcpToolName } from '../mcp/projection.js';
import { parseToolAuthorizationIpcConfig, requestToolAuthorization } from '../tool-authorization-ipc.js';
import { MCP_HUB_CONTEXT_ACTIVE_METHOD, readMcpContextFile, sdkReservedHelperArgumentCount, type McpHubContext } from '../sdk-reserved-helper-context.js';
import { connectControlClient, type ControlClient } from '../daemon/control-client.js';

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
  const { storeDir, productId, contextToken, binding, innerNonces, authorization } = await readMcpContextFile(argv[0]!);
  if (!isHubBinding(binding)) throw new Error('MCP context file has an invalid hub binding');
  if (innerNonces !== undefined && (!Array.isArray(innerNonces) || innerNonces.some(nonce => typeof nonce !== 'string' || nonce.length === 0))) {
    throw new Error('MCP context file has invalid inner nonces');
  }
  const gate = authorization === 'all' ? undefined : parseToolAuthorizationIpcConfig(authorization);
  const privateValues = [contextToken, ...(innerNonces ?? [])];
  if (gate !== undefined) privateValues.push(gate.token);

  let connection: Promise<ControlClient> | undefined;
  const hub = serveMcpHub({
    binding,
    async isActive(signal) {
      signal.throwIfAborted();
      const pending = connection ??= connectControlClient({
        storeDir, productId, onClose: () => { void hub.disconnect(); },
      }).then(result => {
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
    async authorizeCall(call, signal) {
      signal.throwIfAborted();
      if (gate === undefined) return true;
      const verdict = await requestToolAuthorization(gate, {
        toolCallId: randomUUID(),
        toolName: qualifiedMcpToolName(MCP_HUB_SERVER_NAME, HUB_CALL_TOOL),
        cwd: binding.launchCwd,
        input: { ...call },
      }, signal);
      return !signal.aborted && verdict.decision === 'allow';
    },
    containsPrivateValue(value) {
      const json = JSON.stringify(value);
      return privateValues.some(token => json.includes(token));
    },
  });
  try {
    await finished(process.stdin, { cleanup: true });
  } finally {
    const closing = hub.close();
    (await connection?.catch(() => undefined))?.close();
    await closing;
  }
}
