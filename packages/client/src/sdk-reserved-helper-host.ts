import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSdkReservedHelper } from './bin/sdk-reserved-helper-runners';

export const BYOK_SDK_HELPER_SUBCOMMAND = '__byok_sdk_helper';

export type SdkReservedHelperKind = 'agent-message-mcp' | 'agent-memory-mcp' | 'approval-mcp' | 'agent-team-mcp' | 'mcp-env' | 'pi-rpc' | 'pi-prepared';

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
  'agent-memory-mcp': 'byok-agent-memory-mcp.js',
  'approval-mcp': 'byok-approval-mcp.js',
  'agent-team-mcp': 'byok-agent-team-mcp.js',
  'mcp-env': 'byok-mcp-env.js',
  'pi-rpc': 'byok-pi-rpc.js',
  'pi-prepared': 'byok-pi-prepared.js',
});

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

function isHelperKind(value: string | undefined): value is SdkReservedHelperKind {
  return value === 'agent-message-mcp' || value === 'agent-memory-mcp' || value === 'approval-mcp' || value === 'agent-team-mcp' || value === 'mcp-env' || value === 'pi-rpc' || value === 'pi-prepared';
}

/**
 * Product entrypoint seam for single-file/SEA hosts. Returns `false` without
 * side effects for normal product commands; a reserved command is handled to
 * stdio EOF before this resolves `true`.
 */
export async function runSdkReservedHelperCommand(
  argv: readonly string[] = process.argv.slice(2),
): Promise<boolean> {
  if (argv[0] !== BYOK_SDK_HELPER_SUBCOMMAND) return false;
  if (!isHelperKind(argv[1]) || (argv[1] !== 'pi-rpc' && argv[1] !== 'pi-prepared' && argv.length !== 2)) {
    throw new Error('invalid SDK-reserved helper command');
  }
  await runSdkReservedHelper(argv[1], argv.slice(2));
  return true;
}
