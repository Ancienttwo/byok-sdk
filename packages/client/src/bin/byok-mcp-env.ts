#!/usr/bin/env node
import { runMcpEnvLauncher } from './mcp-env-launcher';

runMcpEnvLauncher().catch(() => {
  process.stderr.write('byok-mcp-env: MCP launch failed\n');
  process.exitCode = 1;
});
