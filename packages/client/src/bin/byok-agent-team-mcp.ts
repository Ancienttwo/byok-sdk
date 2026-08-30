#!/usr/bin/env node
import { runSdkReservedHelper } from './sdk-reserved-helper-runners';

runSdkReservedHelper('agent-team-mcp').catch((error: unknown) => {
  process.stderr.write(`byok-agent-team-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
