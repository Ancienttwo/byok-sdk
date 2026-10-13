import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parsePiProviderLauncherOptions, startPiProvider } from '../../../../keys/src/pi-provider-launcher-core';
import { parseModelProviderProfile } from '../../../../keys/src/provider-profile';
import { InMemoryProviderProfileStore } from '../../../../keys/src/profile-store';
import { InMemorySecretStore, modelProviderSecretName } from '../../../../keys/src/secret-store';
// The real keys launch sequence (`startPiProvider`) with in-memory custody.
// The key lives only in this launcher's memory and is read from the fixture
// file named by --profile-db, never from daemon config, env or argv.
const options = parsePiProviderLauncherOptions(process.argv.slice(2));
const fixture = JSON.parse(readFileSync(options.profileDbPath, 'utf8')) as { profile: unknown; secret: string; controlDir: string };
const profile = parseModelProviderProfile(fixture.profile);
if (options.validateOnly) process.exit(0);
const profiles = new InMemoryProviderProfileStore(); await profiles.save(profile);
const secrets = new InMemorySecretStore(); await secrets.set(modelProviderSecretName(profile.profile_ref), fixture.secret);
const launched = await startPiProvider(profile, options, { ambient: process.env, profiles, createSecretStore: () => secrets,
  spawn: (command, args, spawnOptions) => {
    // Unmodified spawn options: stdio stays inherited by the rpc host, and
    // the custody channel is the launcher's own fd 3.
    const child = spawn(command, args, spawnOptions);
    appendFileSync(path.join(fixture.controlDir, 'launches.jsonl'), JSON.stringify({ hostPid: child.pid, args, env: spawnOptions.env, stdio: spawnOptions.stdio }) + '\n');
    return child;
  },
});
const code = await new Promise<number>(resolve => launched.child.once('close', code => resolve(code ?? 1)));
await launched.cleanup(); process.exitCode = code;
