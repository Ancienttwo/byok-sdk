import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BYOK_SDK_HELPER_SUBCOMMAND = '__byok_sdk_helper';

export type SdkReservedHelperKind = 'agent-message-mcp' | 'agent-result-mcp' | 'agent-memory-mcp' | 'agent-memory-describe' | 'agent-team-mcp' | 'pi-rpc' | 'pi-prepared' | 'pi-durable';

export interface SdkHelperHostConfig {
  /**
   * Run SDK-reserved helpers by re-entering the product's single-file/SEA
   * executable. The product entrypoint must call
   * {@link runSdkReservedHelperCommand} before its own argument parser.
   */
  readonly mode: 'self-executable';
  /** Absolute product executable path. Defaults to this process's executable. */
  readonly executable?: string;
  /** Absolute SDK-bearing entry script when executable is an interpreter. */
  readonly entry?: string;
}

export interface ResolvedSdkReservedHelperBin {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: 'dist-script' | 'self-executable';
}

const DIST_SCRIPT_BY_KIND: Readonly<Record<SdkReservedHelperKind, string>> = Object.freeze({
  'agent-message-mcp': 'byok-agent-message-mcp.js',
  'agent-result-mcp': 'byok-agent-result-mcp.js',
  'agent-memory-mcp': 'byok-agent-memory-mcp.js',
  'agent-memory-describe': 'byok-agent-memory-describe.js',
  'agent-team-mcp': 'byok-agent-team-mcp.js',
  'pi-rpc': 'byok-pi-rpc.js',
  'pi-prepared': 'byok-pi-prepared.js',
  'pi-durable': 'byok-pi-durable.js',
});

/** The exact kinds that `runSdkReservedHelperCommand` accepts. */
export const sdkReservedHelperKinds: readonly SdkReservedHelperKind[] = Object.freeze(Object.keys(DIST_SCRIPT_BY_KIND) as SdkReservedHelperKind[]);

function assertExecutable(executable: string): void {
  if (!path.isAbsolute(executable) || /[\u0000\r\n]/u.test(executable)) {
    throw new Error('SdkHelperHostConfig.executable must be an absolute executable path');
  }
}

/** SDK-owned launcher shape used by every reserved stdio helper. */
export function resolveSdkReservedHelperBin(
  kind: SdkReservedHelperKind,
  host?: SdkHelperHostConfig,
): ResolvedSdkReservedHelperBin {
  if (host !== undefined) {
    if (host.mode !== 'self-executable') throw new Error(`unsupported SDK helper host mode: ${String(host.mode)}`);
    const executable = host.executable ?? process.execPath;
    assertExecutable(executable);
    if (host.entry !== undefined && (!path.isAbsolute(host.entry) || /[\u0000\r\n]/u.test(host.entry))) {
      throw new Error('SdkHelperHostConfig.entry must be an absolute single-line script path');
    }
    return Object.freeze({
      command: executable,
      args: Object.freeze([...(host.entry === undefined ? [] : [host.entry]), BYOK_SDK_HELPER_SUBCOMMAND, kind]),
      source: 'self-executable' as const,
    });
  }
  const entryDir = path.dirname(fileURLToPath(import.meta.url));
  // Root, adapters and official CLI bundles all project helpers from dist/bin.
  const entryKind = path.basename(entryDir);
  const distDir = entryKind === 'adapters' || entryKind === 'bin' ? path.dirname(entryDir) : entryDir;
  const script = path.join(
    distDir,
    'bin',
    DIST_SCRIPT_BY_KIND[kind],
  );
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([script]),
    source: 'dist-script' as const,
  });
}

/**
 * The helper host of a single-file product, called from inside that product. A
 * Node SEA re-enters its own executable; a bundle run by Node re-enters Node
 * with the running bundle as its entry. `node:sea` decides which, so nothing is
 * inferred from paths or names.
 */
export function bundledSdkHelperHost(): SdkHelperHostConfig & { readonly executable: string } {
  const sea = process.getBuiltinModule('node:sea') as typeof import('node:sea');
  if (sea.isSea()) return Object.freeze({ mode: 'self-executable' as const, executable: process.execPath });
  const entry = process.argv[1];
  if (entry === undefined || !path.isAbsolute(entry)) throw new Error('bundledSdkHelperHost must run inside a bundle started by node <bundle>');
  return Object.freeze({ mode: 'self-executable' as const, executable: process.execPath, entry });
}
