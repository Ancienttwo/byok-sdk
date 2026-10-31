import { BYOK_SDK_HELPER_SUBCOMMAND, sdkReservedHelperKinds, type SdkReservedHelperKind } from '../sdk-reserved-helper-host';
import { runSdkReservedHelper } from './sdk-reserved-helper-runners';

const RESERVED_HELPER_KIND_SET: ReadonlySet<string> = new Set(sdkReservedHelperKinds);

/**
 * The reserved re-entry is the single-file product, whose bundle holds official
 * Pi (see `SdkHelperHostConfig`). Pi reads the free global `PI_BUNDLED_NODE`
 * once, when its config module evaluates, as its own bundled Node distribution
 * defines it. It then gives extensions the Pi packages and `typebox` from the
 * running bundle, as the installed `pi` CLI does, instead of resolving them on
 * disk beside the bundle, where they are absent (issue #341).
 *
 * Pi evaluates on the runtime host import below, so this must run first. A
 * product bundle that evaluates Pi earlier must define `PI_BUNDLED_NODE` as
 * `true` at build time. The installed thin bins have already evaluated their
 * unbundled Pi when they dispatch here, so the global does not change them.
 */
function declareBundledPiRuntime(): void {
  (globalThis as { PI_BUNDLED_NODE?: boolean }).PI_BUNDLED_NODE = true;
}

/**
 * Pi depends on an exact npm undici (#700). An undici claims the process-wide
 * `fetch` dispatcher when it first evaluates. In an ESM graph, a static
 * `node:http` import makes Node load its own undici first, so Node's copy keeps
 * the dispatcher. In a CommonJS bundle nothing loads it first, so Pi's copy would
 * claim the dispatcher and serve every `fetch` in the process.
 *
 * Node loads its undici when a web global such as `Headers` is first read. Read
 * it before the runtime host import below, which evaluates Pi. The read must be
 * a call: a bundler can drop a bare `globalThis.Headers` statement as pure. Bun
 * has no lazy global, so the read does nothing there.
 */
function loadNodeUndici(): void {
  Reflect.get(globalThis, 'Headers');
}

function isHelperKind(value: string | undefined): value is SdkReservedHelperKind {
  return value !== undefined && RESERVED_HELPER_KIND_SET.has(value);
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
  declareBundledPiRuntime();
  if (!isHelperKind(argv[1]) || (argv[1] !== 'pi-rpc' && argv[1] !== 'pi-prepared' && argv[1] !== 'pi-durable' && argv.length !== 2)) {
    throw new Error('invalid SDK-reserved helper command');
  }
  // These three kinds import the runtime host in `runSdkReservedHelper`. The MCP kinds never load Pi.
  if (argv[1] === 'pi-rpc' || argv[1] === 'pi-prepared' || argv[1] === 'pi-durable') loadNodeUndici();
  await runSdkReservedHelper(argv[1], argv.slice(2));
  return true;
}
