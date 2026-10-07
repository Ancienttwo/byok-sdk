import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSdkReservedHelper } from './bin/sdk-reserved-helper-runners';

export const BYOK_SDK_HELPER_SUBCOMMAND = '__byok_sdk_helper';

export type SdkReservedHelperKind = 'agent-message-mcp' | 'agent-memory-mcp' | 'agent-memory-describe' | 'agent-team-mcp' | 'pi-rpc' | 'pi-prepared' | 'pi-durable';

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
  'agent-memory-describe': 'byok-agent-memory-describe.js',
  'agent-team-mcp': 'byok-agent-team-mcp.js',
  'pi-rpc': 'byok-pi-rpc.js',
  'pi-prepared': 'byok-pi-prepared.js',
  'pi-durable': 'byok-pi-durable.js',
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
  return value === 'agent-message-mcp' || value === 'agent-memory-mcp' || value === 'agent-memory-describe' || value === 'agent-team-mcp' || value === 'pi-rpc' || value === 'pi-prepared' || value === 'pi-durable';
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
  if (argv[1] === 'pi-subagent-runner') {
    // A Pi subagent runner child (`subagents/spawn.ts`). The tail is the
    // runner config path. The runtime host is an external-dynamic import so
    // the library root never loads the vendored runner closure.
    if (argv.length !== 3) throw new Error('invalid SDK-reserved helper command');
    const host = await import('#byok-pi-runtime-host');
    await host.runSubagentRunner(argv[2]!);
    return true;
  }
  if (argv[1] === 'pi-subagent-print') {
    // A Pi subagent print child (`subagents/spawn.ts`). The tail is the
    // vendor's pi-style print argv.
    const host = await import('#byok-pi-runtime-host');
    const exitCode = await host.runSubagentPrint(argv.slice(2));
    if (exitCode !== 0) throw new Error(`pi-subagent-print exited ${exitCode}`);
    return true;
  }
  if (!isHelperKind(argv[1]) || (argv[1] !== 'pi-rpc' && argv[1] !== 'pi-prepared' && argv[1] !== 'pi-durable' && argv.length !== 2)) {
    throw new Error('invalid SDK-reserved helper command');
  }
  await runSdkReservedHelper(argv[1], argv.slice(2));
  return true;
}
