import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  adoptOwnedProcessTree, disposeOwnedProcessTree, requestOwnedProcessTreeTermination, withOwnedProcessTree,
} from '../adapters/process-tree.js';
import { assertNoNulSpawnInput, spawnStartError } from '@byok-sdk/core/system-tool';
import { withoutProviderCredentials } from '../adapters/provider-credential-environment.js';

const LABEL = 'acp terminal';

interface SpawnDependencies {
  nativeAssetRoot?: string;
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
  jobObject?: { assign(pid: number): Promise<{ release(): void }> };
}

/**
 * A command an ACP agent asks its client to run (`terminal/create`), inside
 * the same owned-tree authority as the agent process: its own POSIX process
 * group or Windows job, the host-exit backstop and the durable group ledger.
 * The ACP host supplies the session environment overlaid with peer entries.
 * Strip provider credentials from that final environment before spawning.
 */
// Structural return types keep the BYOK source declaration build independent of the unconnected vendor tree.
export function createOwnedTerminalSpawn(deps: SpawnDependencies = {}) {
  return (command: string, args: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly shell: boolean }) => {
    if (options.env === undefined) throw new Error('owned terminal process requires an explicit environment');
    assertNoNulSpawnInput(command, args, options.env, options.cwd);
    const env = withoutProviderCredentials(options.env);
    let child: ChildProcess;
    try {
      child = (deps.spawnFn ?? spawn)(command, [...args], withOwnedProcessTree({
        cwd: options.cwd, env, shell: options.shell, stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (error) {
      throw spawnStartError(error);
    }
    let closed = false;
    let resolveClosed!: () => void;
    const closeReceipt = new Promise<void>(resolve => { resolveClosed = resolve; });
    child.once('close', () => { closed = true; resolveClosed(); });
    const tree = { child, waitClosed: () => closeReceipt, isClosed: () => closed, label: LABEL, platform: deps.platform };
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposal ??= disposeOwnedProcessTree(tree).catch(error => { disposal = undefined; throw error; });
      return disposal;
    };
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('error', (error: NodeJS.ErrnoException) => reject(spawnStartError(error)));
      child.once('spawn', () => {
        // Fail closed: a tree nothing owns is ended before the agent hears of it.
        adoptOwnedProcessTree({ child, label: LABEL, platform: deps.platform, jobObject: deps.jobObject, nativeAssetRoot: deps.nativeAssetRoot, boundOutputPipes: true })
          .then(resolve, (error: unknown) => { void dispose().catch(() => {}); reject(error); });
      });
    });
    // The terminal host awaits `spawned`; this only keeps an unobserved failure from going unhandled.
    void spawned.catch(() => {});
    return {
      child,
      spawned,
      terminate(): void { void requestOwnedProcessTreeTermination(tree).catch(() => {}); },
      dispose,
    };
  };
}

export const spawnOwnedTerminalProcess = createOwnedTerminalSpawn();
