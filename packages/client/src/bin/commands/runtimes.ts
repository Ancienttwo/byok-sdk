import { type DaemonConfig, type RuntimeAdapter } from '../../index.js';
import { formatRuntimeLines } from '../../diagnostics/format.js';
import { probeRuntimes } from '../../diagnostics/runtime-probe.js';
import { buildRuntimeAdapters, resolvePiByokLauncher } from '../../adapters/runtime-adapters.js';

export interface RuntimesDeps {
  log?: (line: string) => void;
  /** DI for tests: probe these adapters instead of constructing the real bundled pi/claude/codex set. */
  adapters?: RuntimeAdapter[];
}

export async function runRuntimesCommand(config: DaemonConfig, deps: RuntimesDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const adapters = deps.adapters ?? buildRuntimeAdapters(config, resolvePiByokLauncher(config));
  const runtimes = await probeRuntimes(adapters);
  for (const line of formatRuntimeLines(runtimes)) log(line);
}
