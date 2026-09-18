#!/usr/bin/env node

// WP4 helper seam: the custody dispatcher mints child templates over THIS
// entry (`node <runtime> __byok_sdk_helper pi-subagent-print|pi-subagent-runner`),
// so the reserved-helper command is handled before this bin's own parser. The
// dispatch MUST ride the same external `#byok-pi-runtime-host` seam as the
// host call below: the helper host graph carries the custody preset entries,
// whose module-init CLI guard keys on `import.meta.main` — a copy inlined into
// this thin bin would see `main === true` whenever this bin is the executed
// entry and mis-run the print entry's argv gate on ordinary product argv. The
// helper runs to completion inside runSdkReservedHelperCommand; a nonzero exit
// propagates. Normal product argv falls through untouched.
import('#byok-pi-runtime-host')
  .then(async (host) => {
    const argv = process.argv.slice(2);
    if (await host.runSdkReservedHelperCommand(argv)) return undefined;
    return host.runPiPreparedHost(argv);
  })
  .catch((error: unknown) => {
    process.stderr.write(`byok-pi-prepared: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
