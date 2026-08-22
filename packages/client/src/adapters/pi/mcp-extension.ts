import { readFileSync } from 'node:fs';
import { createMcpAdapter } from 'pi-mcp-adapter';
import type { McpConfig } from 'pi-mcp-adapter/types';
import { BYOK_PI_MCP_CONFIG_PATH } from './mcp-config';

function loadTaskScopedConfig(): McpConfig {
  const configPath = process.env[BYOK_PI_MCP_CONFIG_PATH];
  if (!configPath) {
    throw new Error(`${BYOK_PI_MCP_CONFIG_PATH} is required for the BYOK Pi MCP extension`);
  }

  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Object.prototype.hasOwnProperty.call(parsed, 'mcpServers') ||
    (parsed as { mcpServers?: unknown }).mcpServers === null ||
    typeof (parsed as { mcpServers?: unknown }).mcpServers !== 'object' ||
    Array.isArray((parsed as { mcpServers?: unknown }).mcpServers)
  ) {
    throw new Error('BYOK Pi MCP configuration must contain an mcpServers object');
  }
  return parsed as McpConfig;
}

// Supplying `config` is pi-mcp-adapter's isolated SDK mode: it deliberately
// does not merge ~/.config/mcp, .mcp.json, Pi settings, imports, or argv.
export default createMcpAdapter({ config: loadTaskScopedConfig() });
