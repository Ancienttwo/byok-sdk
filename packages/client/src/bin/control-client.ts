/**
 * CLI-facing name for the control client.
 *
 * The implementation lives in the daemon layer (`../daemon/control-client.ts`)
 * so daemon modules such as `assertion-client.ts` do not depend upward on an
 * entry-point directory (#1099). This module is only a re-export shell; new
 * internal callers should import `../daemon/control-client` directly.
 */

export {
  connectControlClient,
  isControlDaemonGone,
  requestInputPreparation,
  lookupInputPreparation,
  cancelInputPreparation,
} from '../daemon/control-client';
export type {
  ControlClientOptions,
  ControlClient,
  ConnectControlResult,
} from '../daemon/control-client';
