#!/usr/bin/env node
import { runSdkReservedHelper } from './sdk-reserved-helper-runners';

runSdkReservedHelper('agent-message-mcp').catch((error: unknown) => {
  process.stderr.write(`byok-agent-message-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
