// Issue #392 e2e child: does what `byok-agent start [--service]` does, in the
// same order — adopt the login-shell environment first, then build, pair and
// start a daemon — with an explicitly injected test credential backend.
// BYOK_TEST_ENV_MARKER is only an inert capture/strip marker.
// Prints one JSON line once started; stops on SIGTERM.
import { readFileSync } from 'node:fs';
import { applyLoginShellEnvironment, createDaemon } from '../../../dist/index.js';
import { InMemoryDeviceCredentialStore } from '../../../../../scripts/testing/device-credentials.mjs';

const [configPath, flag] = process.argv.slice(2);
if (flag === '--service') await applyLoginShellEnvironment();
const config = { ...JSON.parse(readFileSync(configPath, 'utf8')), localAgentRelease: { version: '0.0.0-test' } };
const daemon = createDaemon(config, { deviceCredentials: new InMemoryDeviceCredentialStore() });
let detected = [];
daemon.subscribe((event) => {
  if (event.kind === 'runtimes-detected') detected = event.runtimes.filter((runtime) => runtime.outcome === 'available').map((runtime) => runtime.id);
});
await daemon.pair('pairing-code');
await daemon.start();
process.stdout.write(`${JSON.stringify({
  ready: true,
  environment: daemon.status().environment,
  runtimes: daemon.status().runtimes,
  detected,
  byokNames: Object.keys(process.env).filter((name) => name.startsWith('BYOK_')).sort(),
  pathHasFakeBin: (process.env.PATH ?? '').split(':').some((entry) => entry.endsWith('/fakebin')),
})}\n`);
process.on('SIGTERM', () => {
  void daemon.stop().then(() => process.exit(0), () => process.exit(1));
});
