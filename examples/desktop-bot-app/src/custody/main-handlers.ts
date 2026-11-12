/** Main's answers to `keys.submit` (the one place the secret passes through main) and `keys.list`. */
import type { MethodHandlers } from '../bridge/domain.ts';
import type { KeysMethods } from '../bridge/domains/keys.ts';
import { BridgeError } from '../bridge/protocol.ts';
import { CUSTODY_COMMAND, CustodyError, type CustodyChange } from './protocol.ts';
import { listFromCustody, submitToCustody, type CustodyChild } from './submit.ts';

export interface KeysMainDependencies {
  /** Spawns the Host executable with these arguments: dev runs the Host bundle under Node, a package runs the SEA. */
  readonly spawnHostCommand: (args: readonly string[]) => CustodyChild;
  readonly callHost: (method: 'keys.profilesChanged', params: undefined) => Promise<null>;
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
      await deps.callHost('keys.profilesChanged', undefined);
      return status;
    },
    // A read: one custody child per call, no copy kept in main or the Host.
    'keys.list': async params => {
      if (params !== undefined) throw new BridgeError('invalid_params', 'keys.list takes no params');
      return listFromCustody(deps.spawnHostCommand([CUSTODY_COMMAND]));
    },
  };
}
