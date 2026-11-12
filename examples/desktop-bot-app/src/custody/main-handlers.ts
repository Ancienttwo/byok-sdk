/** Main's answers to `keys.submit` (the one place the secret passes through main) and `keys.list`. */
import type { MethodHandlers } from '../bridge/domain.ts';
import type { KeysMethods } from '../bridge/domains/keys.ts';
import { BridgeError, type BridgeErrorCode } from '../bridge/protocol.ts';
import { CUSTODY_COMMAND, CustodyError, type CustodyChange } from './protocol.ts';
import { CUSTODY_DEADLINE_MS, listFromCustody, submitToCustody, type CustodyChild } from './submit.ts';

export interface KeysMainDependencies {
  /** Spawns the Host executable with these arguments: dev runs the Host bundle under Node, a package runs the SEA. */
  readonly spawnHostCommand: (args: readonly string[]) => CustodyChild;
  readonly callHost: (method: 'keys.profilesChanged', params: undefined) => Promise<null>;
}

const HOST_NOT_SERVING: ReadonlySet<BridgeErrorCode> = new Set(['host_exited', 'unknown_method']);

/** Reapplying the persisted catalog is idempotent; only the wait is bounded, never the saved key write retried. */
async function refreshProfiles(deps: KeysMainDependencies, saved: boolean): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      deps.callHost('keys.profilesChanged', undefined),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new CustodyError('catalog_refresh_timeout',
          `${saved ? 'The key change was saved' : 'Stored providers were read'}, but the Host has not confirmed its catalog update. Reload stored providers; do not repeat the save.`)), CUSTODY_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Spawns one custody child per submission and passes the renderer's params
 * through unread: the child owns their validation. After a receipt the Host
 * rereads the keys store; nothing here logs or keeps the params.
 */
export function keysMainHandlers(deps: KeysMainDependencies): MethodHandlers<Pick<KeysMethods, 'keys.submit' | 'keys.list'>> {
  return {
    'keys.submit': async params => {
      // The one field main reads: a list is not a change, so it never reaches custody as one.
      if ((params as { op?: unknown } | null)?.op === 'list') throw new BridgeError('invalid_params', 'keys.submit takes configure or replace_secret; keys.list lists');
      let status;
      try {
        status = await submitToCustody(deps.spawnHostCommand([CUSTODY_COMMAND]), params as CustodyChange);
      } catch (error) {
        if (error instanceof CustodyError && error.code === 'custody_request_invalid') throw new BridgeError('invalid_params', error.message);
        throw error;
      }
      await refreshProfiles(deps, true);
      return status;
    },
    // A read also reconciles a running Host after an uncertain submission, without repeating its write.
    'keys.list': async params => {
      if (params !== undefined) throw new BridgeError('invalid_params', 'keys.list takes no params');
      const statuses = await listFromCustody(deps.spawnHostCommand([CUSTODY_COMMAND]));
      try {
        await refreshProfiles(deps, false);
      } catch (error) {
        // No running Host to reconcile: a stopped Host serves no keys domain, and the next start loads the catalog from the store.
        if (!(error instanceof BridgeError && HOST_NOT_SERVING.has(error.code))) throw error;
      }
      return statuses;
    },
  };
}
