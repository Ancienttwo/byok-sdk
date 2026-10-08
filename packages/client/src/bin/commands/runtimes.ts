import { type DaemonConfig, type RuntimeAdapter } from '../../index';
import { formatRuntimeLines } from '../format';
import { defaultRuntimeAdapters, probeRuntimes } from '../runtime-probe';

export interface RuntimesDeps {
  log?: (line: string) => void;
  /** DI for tests: probe these adapters instead of constructing the real bundled pi/claude/codex set. */
  adapters?: RuntimeAdapter[];
}

export async function runRuntimesCommand(config: DaemonConfig, deps: RuntimesDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const adapters = deps.adapters ?? defaultRuntimeAdapters(config.runtimeAllowlist);
  const runtimes = await probeRuntimes(adapters);
  for (const line of formatRuntimeLines(runtimes)) log(line);
}
