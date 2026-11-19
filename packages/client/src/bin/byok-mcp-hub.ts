#!/usr/bin/env node
import { runMcpHub } from '#byok-mcp-hub-runtime';

runMcpHub(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`byok-mcp-hub: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
