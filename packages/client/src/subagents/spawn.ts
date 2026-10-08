import { realpathSync, statSync } from 'node:fs';

/**
 * The spawn command of one Pi subagent child.
 *
 * The child re-enters the bundle this process runs from:
 * `<runtime> [<entry>] __byok_sdk_helper <child> ...tail`. The SDK-reserved
 * helper host (`../sdk-reserved-helper-host.ts`) routes that argv to the print
 * or runner payload. Depth and running limits stay with the vendored subagents
 * extension (`PI_SUBAGENT_MAX_DEPTH` and its concurrency cap), as in OAR.
 */
export type PiSubagentChild = 'pi-subagent-print' | 'pi-subagent-runner';

/** The same literal as `BYOK_SDK_HELPER_SUBCOMMAND`; this leaf module imports nothing from the helper host. */
const HELPER_SUBCOMMAND = '__byok_sdk_helper';

export function resolvePiSubagentSpawn(
  child: PiSubagentChild,
  tail: readonly string[],
): { command: string; args: string[] } {
  const command = process.execPath;
  let entry: string | undefined;
  const entryArg = process.argv[1];
  if (entryArg) {
    try {
      const real = realpathSync(entryArg);
      if (statSync(real).isFile() && real !== realpathSync(command)) entry = real;
    } catch {
      // A single-file executable has no separate entry script.
    }
  }
  return { command, args: [...(entry === undefined ? [] : [entry]), HELPER_SUBCOMMAND, child, ...tail] };
}
