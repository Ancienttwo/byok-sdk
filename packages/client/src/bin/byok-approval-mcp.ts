#!/usr/bin/env node
import { runSdkReservedHelper } from './sdk-reserved-helper-runners';

runSdkReservedHelper('approval-mcp').catch((error: unknown) => {
  process.stderr.write(`byok-approval-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
