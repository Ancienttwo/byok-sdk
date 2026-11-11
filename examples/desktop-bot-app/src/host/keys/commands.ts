import { CUSTODY_COMMAND } from '../../custody/protocol.ts';
import { runCustodyCommand } from '../../custody/child.ts';
import { keysDbPath, PI_LAUNCHER_COMMAND, runPiLauncher } from './launcher.ts';
import { platformSecretStore } from './secret-store.ts';

/**
 * The Host executable's keys roles, chosen by argv after the SDK-reserved
 * helpers and before the Host itself: custody and the Pi provider launcher.
 * Resolves to the exit code, or `undefined` when argv names neither, so
 * the caller starts the Host only then. A failure rejects, so the caller's
 * one exit(1) path reports it.
 */
export async function runKeysCommand(args: readonly string[], hostStorageRoot: string): Promise<number | undefined> {
  if (args[0] === CUSTODY_COMMAND) {
    // The request travels on stdin only; any argument after the command is refused.
    if (args.length !== 1) throw new Error(`${CUSTODY_COMMAND} takes no arguments`);
    return runCustodyCommand(keysDbPath(hostStorageRoot), () => platformSecretStore());
  }
  if (args[0] !== PI_LAUNCHER_COMMAND) return undefined;
  return runPiLauncher(args.slice(1));
}
