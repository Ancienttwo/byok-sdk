#!/usr/bin/env node

// SDK-reserved helpers re-enter THIS entry (`<runtime> <this bin>
// __byok_sdk_helper <kind>`), so the reserved-helper command is handled before
// this bin's own parser. The dispatch rides the same external
// `#byok-pi-runtime-host` seam as the host call below. Normal product argv
// falls through untouched.

// #700: Node's own undici loads before Pi's npm copy (see `loadNodeUndici` in
// `sdk-reserved-helper-command.ts`).
Reflect.get(globalThis, 'Headers');
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
