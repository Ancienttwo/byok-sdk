import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parsePiProviderLauncherOptions, startPiProvider } from '../../../../keys/src/pi-provider-launcher-core';
import { parseModelProviderProfile, assertExactProviderProfileBinding } from '../../../../keys/src/provider-profile';
import { InMemoryProviderProfileStore } from '../../../../keys/src/profile-store';
import { InMemorySecretStore, modelProviderSecretName } from '../../../../keys/src/secret-store';
// Deliberately only in launcher memory; not daemon config/env/argv or on-disk execution state.
const SENTINEL = 'BYOK_KNIFE3_PROVIDER_SECRET_SENTINEL';
const options = parsePiProviderLauncherOptions(process.argv.slice(2));
const fixture = JSON.parse(readFileSync(options.profileDbPath,'utf8')) as {profile:unknown;controlDir:string};
const profile = parseModelProviderProfile(fixture.profile);
if (options.expectedBinding) assertExactProviderProfileBinding(profile, options.expectedBinding);
if (options.validateOnly) process.exit(0);
const profiles = new InMemoryProviderProfileStore(); await profiles.save(profile);
const secrets = new InMemorySecretStore(); await secrets.set(modelProviderSecretName(profile.profile_ref),SENTINEL);
const launched = await startPiProvider(profile,options,{ambient:process.env,profiles,createSecretStore:()=>secrets,
  spawn:(command,args,spawnOptions) => {
    const configPath = args.at(-1)!;
    const config = JSON.parse(readFileSync(configPath,'utf8'));
    const child = spawn(command,args,{...spawnOptions,stdio:['inherit','pipe','pipe','ipc']});
    child.on('message', value => appendFileSync(path.join(fixture.controlDir,'ipc-events.jsonl'),JSON.stringify({phase:'request',type:(value as {type?:unknown}).type})+'\n'));
    child.on('disconnect',()=>appendFileSync(path.join(fixture.controlDir,'ipc-events.jsonl'),JSON.stringify({phase:'disconnect'})+'\n'));
    appendFileSync(path.join(fixture.controlDir,'launches.jsonl'),JSON.stringify({launcherPid:process.pid,workerPid:child.pid,taskId:config.replica.taskId,args,env:spawnOptions.env,configPath})+'\n');
    child.stdout!.on('data',chunk => { appendFileSync(path.join(fixture.controlDir,'worker-rpc.log'),chunk); process.stdout.write(chunk); });
    child.stderr!.on('data',chunk => { appendFileSync(path.join(fixture.controlDir,'worker-stderr.log'),chunk); process.stderr.write(chunk); });
    return child;
  },
});
const code = await new Promise<number>(resolve => launched.child.once('close', code => resolve(code ?? 1)));
await launched.cleanup(); process.exitCode=code;
