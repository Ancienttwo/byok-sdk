import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const {createDaemon, FixtureDeviceStore} = await import(pathToFileURL(config.clientEntry).href);
const enrollment = await new Promise(resolve => process.once('message', resolve));
const store = new FixtureDeviceStore(config.storeDir, undefined, config.productId);
if (enrollment.record) await store.credentials.replace(enrollment.record);
const daemon = createDaemon({
  localAgentRelease:{version:'0.0.0-durable-recovery-test'},productName:'Durable recovery',productId:config.productId,serverUrl:config.serverUrl,
  storeDir:config.storeDir, workspaceRoot:config.workspaceRoot, runtimeAllowlist:['pi'],durablePi:true,hostedJournal:{mode:'sqlite'},
  agentHome:{hostStorageRoot:config.homeRoot},
  piByokLauncher:{command:process.execPath,args:[config.launcherEntry],profileDbPath:config.profilePath,sessionDir:config.sessionDir},
});
if (!enrollment.record) await daemon.pair('pairing-code');
await daemon.start();
process.send({record:await store.credentials.read()}); // Device authority only, never a provider key; test controller holds it in memory.
console.log(JSON.stringify({ready:true,pid:process.pid}));
const lines = createInterface({input:process.stdin});
lines.on('line', line => { void (async () => {
  if (JSON.parse(line).command !== 'stop') throw new Error('unexpected fixture command');
  await daemon.stop(); console.log(JSON.stringify({stopped:true})); lines.close(); process.disconnect();
})().catch(error => { console.error(error); process.exitCode=1; }); });
