import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveBunBin } from '../support/test-bun-bin';

/**
 * The executable a test gives the adapter as Hermes. POSIX runs `script`
 * through its shebang. Windows spawns no script without a shell, so `script`
 * runs behind a compiled `hermes.exe` in `outDir` that starts Node as its
 * child. That is the shape of a Windows venv console-script launcher: the
 * gateway that answers `identify` is a child of the process the adapter
 * spawned.
 */
export function fakeHermesCommand(script: string, outDir: string): string {
  if (process.platform !== 'win32') return script;
  // The candidate list names POSIX paths; on Windows the CI jobs put bun.exe on PATH.
  const bun = resolveBunBin() ?? 'bun';
  const source = path.join(outDir, 'hermes-launcher.mjs');
  writeFileSync(source, `import { spawn } from 'node:child_process';
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(script)}, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
child.on('error', () => process.exit(127));
child.on('exit', (code) => process.exit(code ?? 1));
`);
  const executable = path.join(outDir, 'hermes.exe');
  execFileSync(bun, ['build', source, '--compile', '--outfile', executable], { stdio: 'pipe' });
  return executable;
}
