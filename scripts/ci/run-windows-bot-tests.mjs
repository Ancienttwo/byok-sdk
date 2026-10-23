import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// #738: openTeam -> createBotPersonaProjection writes AGENTS.md with the SDK
// writeHomeFile, which runs on Windows. Every K8 suite runs here, with the
// same assertions as on Linux and macOS.
export const windowsBotArgs = () => ['run', '--cwd', 'examples/bot-collaboration', 'test'];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`K8 Windows suite, no exclusions; actual platform: ${process.platform}`);
  const result = spawnSync('bun', windowsBotArgs(), {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit', env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
