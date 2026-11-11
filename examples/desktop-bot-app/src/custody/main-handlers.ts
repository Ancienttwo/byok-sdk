/** Main's answer to `keys.submit`: the one place the secret passes through main. */
import type { MethodHandlers } from '../bridge/domain.ts';
import type { KeysMethods } from '../bridge/domains/keys.ts';
import { BridgeError } from '../bridge/protocol.ts';
import { CUSTODY_COMMAND, CustodyError, type CustodyRequest } from './protocol.ts';
import { submitToCustody, type CustodyChild } from './submit.ts';

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
export function keysMainHandlers(deps: KeysMainDependencies): MethodHandlers<Pick<KeysMethods, 'keys.submit'>> {
  return {
    'keys.submit': async params => {
      let status;
      try {
        status = await submitToCustody(deps.spawnHostCommand([CUSTODY_COMMAND]), params as CustodyRequest);
      } catch (error) {
        if (error instanceof CustodyError && error.code === 'custody_request_invalid') throw new BridgeError('invalid_params', error.message);
        throw error;
      }
      await deps.callHost('keys.profilesChanged', undefined);
      return status;
    },
  };
}
