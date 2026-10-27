import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { InMemoryDeviceCredentialStore } from '../../../../../scripts/testing/device-credentials.mjs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const {createDaemon} = await import(pathToFileURL(config.clientEntry).href);
const enrollment = await new Promise(resolve => process.once('message', resolve));
const credentials = new InMemoryDeviceCredentialStore();
if (enrollment.record) await credentials.replace(enrollment.record);
const daemon = createDaemon({
  localAgentRelease:{version:'0.0.0-durable-recovery-test'},productName:'Durable recovery',productId:config.productId,serverUrl:config.serverUrl,
  storage:{scratchRoot:config.scratchRoot},storeDir:config.storeDir, runtimeAllowlist:['pi'],durablePi:true,
  agentHome:{hostStorageRoot:config.homeRoot},agentEgress:{policy:config.egressPolicy},
  piByokLauncher:{command:process.execPath,args:[config.launcherEntry],profileDbPath:config.profilePath,sessionDir:config.sessionDir},
}, { deviceCredentials: credentials });
if (!enrollment.record) await daemon.pair('pairing-code');
await daemon.start();
// #391: start() is local startup only; "ready" means the server accepted this run's hello.
for (const deadline = Date.now() + 10_000; !(daemon.status().lifecycle.phase === 'running' && daemon.status().lifecycle.connection === 'open');) {
  if (daemon.status().lifecycle.phase === 'halted' || Date.now() >= deadline) throw new Error(`daemon did not open: ${JSON.stringify(daemon.status().lifecycle)}`);
  await new Promise(resolve => setTimeout(resolve, 10));
}
process.send({record:await credentials.read()}); // Device authority only, never a provider key; test controller holds it in memory.
console.log(JSON.stringify({ready:true,pid:process.pid}));
const lines = createInterface({input:process.stdin});
lines.on('line', line => { void (async () => {
  if (JSON.parse(line).command !== 'stop') throw new Error('unexpected fixture command');
  await daemon.stop(); console.log(JSON.stringify({stopped:true})); lines.close(); process.disconnect();
})().catch(error => { console.error(error); process.exitCode=1; }); });
