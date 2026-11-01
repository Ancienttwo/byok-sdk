import path from 'node:path';
import type { RuntimeExecutableSource } from '../types';

/** The bin an adapter's resolution chose, and who chose it. */
export interface ResolvedRuntimeCommand<B extends { readonly command: string } = { readonly command: string }> {
  readonly bin: B;
  readonly source: RuntimeExecutableSource;
}

/**
 * Run the adapter's one bin resolution: the Host's `resolveBin` option when
 * set (`config`), else the built-in resolver, whose own source is `env` for a
 * `BYOK_<RUNTIME>_BIN` override or `path` for the bare command name.
 */
export function resolveRuntimeCommand<B extends { readonly command: string; readonly source: 'env' | 'path' }>(
  configured: (() => B) | undefined,
  builtIn: () => B,
): ResolvedRuntimeCommand<B> {
  if (configured !== undefined) return { bin: configured(), source: 'config' };
  const bin = builtIn();
  return { bin, source: bin.source };
}

/**
 * Detection fields for the executable a probe ran (#1103 O10). The path is
 * reported only when it is absolute: a bare name is found by the OS at spawn,
 * so the SDK has no resolved path to report and never searches PATH again for
 * one.
 */
export function runtimeExecutableFields(
  resolved: Pick<ResolvedRuntimeCommand, 'source'>,
  executable: string,
): { readonly executablePath?: string; readonly executableSource: RuntimeExecutableSource } {
  return { executableSource: resolved.source, ...(path.isAbsolute(executable) ? { executablePath: executable } : {}) };
}
