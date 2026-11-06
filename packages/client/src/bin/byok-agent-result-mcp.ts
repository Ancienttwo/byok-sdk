#!/usr/bin/env node
import { runSdkReservedHelper } from './sdk-reserved-helper-runners';

runSdkReservedHelper('agent-result-mcp', process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`byok-agent-result-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
