#!/usr/bin/env node
// #700: Node's own undici loads before Pi's npm copy (see `loadNodeUndici` in
// `sdk-reserved-helper-command.ts`).
Reflect.get(globalThis, 'Headers');
import('#byok-pi-runtime-host').then(async host => {
  const argv = process.argv.slice(2);
  if (await host.runSdkReservedHelperCommand(argv)) return;
  await host.runPiDurableHost(argv);
}).catch(() => { process.stderr.write('byok-pi-durable: launch failed\n'); process.exit(78); });
