#!/usr/bin/env node

// Pi subagent children re-enter THIS entry
// (`<runtime> <this bin> __byok_sdk_helper pi-subagent-print|pi-subagent-runner`),
// so the reserved-helper command is handled before this bin's own parser. The
// dispatch rides the same external `#byok-pi-runtime-host` seam as the host
// call below. Normal product argv falls through untouched.
import('#byok-pi-runtime-host')
  .then(async (host) => {
    const argv = process.argv.slice(2);
    if (await host.runSdkReservedHelperCommand(argv)) return undefined;
    return host.runPiRpcHost(argv);
  })
  .catch((error: unknown) => {
    process.stderr.write(`byok-pi-rpc: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
