#!/usr/bin/env node
import { runSdkReservedHelper } from './sdk-reserved-helper-runners.js';

runSdkReservedHelper('agent-message-mcp', process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`byok-agent-message-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
