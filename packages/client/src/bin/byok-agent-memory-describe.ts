#!/usr/bin/env node
import { runSdkReservedHelper } from './sdk-reserved-helper-runners';

runSdkReservedHelper('agent-memory-describe').catch((error: unknown) => {
  process.stderr.write(`byok-agent-memory-describe: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
