#!/usr/bin/env node
import('#byok-pi-runtime-host').then(async host => {
  const argv = process.argv.slice(2);
  if (await host.runSdkReservedHelperCommand(argv)) return;
  await host.runPiDurableHost(argv);
}).catch(() => { process.stderr.write('byok-pi-durable: launch failed\n'); process.exit(78); });
