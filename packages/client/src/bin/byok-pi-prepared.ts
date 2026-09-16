#!/usr/bin/env node

import('#byok-pi-runtime-host').then((host) => host.runPiPreparedHost(process.argv.slice(2))).catch((error: unknown) => {
  process.stderr.write(`byok-pi-prepared: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
