// Issue #392 e2e child: does what `byok-agent start [--service]` does, in the
// same order — adopt the login-shell environment first, then build, pair and
// start a daemon — but pairs in-process so the test credential double
// (BYOK_TEST_DEVICE_CREDENTIAL_STORE=1, a BYOK_* value the capture must keep)
// holds the secret. Prints one JSON line once started; stops on SIGTERM.
import { readFileSync } from 'node:fs';
import { applyLoginShellEnvironment, createDaemon } from '../../../dist/index.js';

const [configPath, flag] = process.argv.slice(2);
if (flag === '--service') await applyLoginShellEnvironment();
const config = { ...JSON.parse(readFileSync(configPath, 'utf8')), localAgentRelease: { version: '0.0.0-test' } };
const daemon = createDaemon(config);
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
