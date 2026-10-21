import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// #611: these suites use openTeam -> createBotPersonaProjection -> directory
// open/fsync, whose documented persistence contract is POSIX-only. Keep all
// existing assertions and the full Linux suite; never substitute a consumer.
export const windowsPersonaSuites = Object.freeze([
  'acceptance-fixes', 'channel-team', 'coalesce-team', 'cross-bot-cancel',
  'cross-bot-chain', 'cross-bot-device', 'cross-bot-discovery', 'cross-bot-encoding',
  'cross-bot-join', 'cross-bot-lifecycle', 'cross-bot-reliability', 'cross-bot',
  'group-chat', 'main-bot-cancel',
].map(name => `src/${name}.test.ts`));

export const windowsBotArgs = () => [
  'run', '--cwd', 'examples/bot-collaboration', 'test', '--',
  ...windowsPersonaSuites.flatMap(path => ['--exclude', path]),
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`K8 Windows eligibility suite; actual platform: ${process.platform}`);
  for (const path of windowsPersonaSuites) console.log(`EXCLUDED ${path}: POSIX-only persona directory open/fsync; Windows persistence is unsupported`);
  const result = spawnSync('bun', windowsBotArgs(), {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit', env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
