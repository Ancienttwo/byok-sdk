// #1329 Q4/Q5 stop program, run as the standard user: optionally writes the
// launcher stop marker, sends the control `shutdown` RPC the way
// `bin/commands/unpair.ts` does, waits for the daemon to be gone, and reports
// whether control.token and daemon-owner.json remain.
//   node stop.mjs <productId> [stop-marker] [--no-shutdown]
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectControlClient, isControlDaemonGone } from '../../../packages/client/src/daemon/control-client';
import { controlTokenPath } from '../../../packages/client/src/daemon/control-protocol';
import { defaultStoreDir } from '../../../packages/client/src/daemon/host-layout';
import { DAEMON_OWNER_FILENAME } from '../../../packages/client/src/util/daemon-owner';

const args = process.argv.slice(2);
const noShutdown = args.includes('--no-shutdown');
const [productId, marker] = args.filter((a) => !a.startsWith('--'));
const storeDir = defaultStoreDir(productId);
const files = () => ({
  'control.token': existsSync(controlTokenPath(storeDir)),
  [DAEMON_OWNER_FILENAME]: existsSync(path.join(storeDir, DAEMON_OWNER_FILENAME)),
});
console.log(JSON.stringify({ phase: 'before', storeDir, ...files() }));

if (!noShutdown) {
  if (marker) writeFileSync(marker, 'stopped\n');
  const conn = await connectControlClient({ storeDir, productId });
  if (!conn.ok) {
    console.log(JSON.stringify({ phase: 'connect', ok: false, reason: conn.reason }));
    process.exit(2);
  }
  const status = await conn.client.request('status').catch((err: unknown) => String(err));
  console.log(JSON.stringify({ phase: 'status', status }));
  const reply = await conn.client.request('shutdown', { reason: 'probe-stop' }).then(
    (r) => ({ ok: true, r }),
    (err: unknown) => ({ ok: false, err: String(err) }),
  );
  conn.client.close();
  console.log(JSON.stringify({ phase: 'shutdown', ...reply }));
  const deadline = Date.now() + 15_000;
  let gone = false;
  while (!(gone = await isControlDaemonGone(storeDir, productId)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(JSON.stringify({ phase: 'gone', gone }));
}
const after = files();
console.log(JSON.stringify({ phase: 'after', ...after }));
process.exit(after['control.token'] || after[DAEMON_OWNER_FILENAME] ? 1 : 0);
