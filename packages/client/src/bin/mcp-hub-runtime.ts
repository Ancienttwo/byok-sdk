import { isAbsolute } from 'node:path';
import { finished } from 'node:stream/promises';
import type { McpStdioServerSpec } from '../mcp/client.js';
import { serveMcpHub } from '../mcp/hub/index.js';
import { isJsonObject } from '../mcp/hub/protocol.js';
import { readMcpContextFile, sdkReservedHelperArgumentCount, type McpHubContext } from '../sdk-reserved-helper-context.js';

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
  const { binding } = await readMcpContextFile(argv[0]!);
  if (!isHubBinding(binding)) throw new Error('MCP context file has an invalid hub binding');
  const hub = serveMcpHub({ binding });
  try {
    await finished(process.stdin, { cleanup: true });
  } finally {
    await hub.close();
  }
}
