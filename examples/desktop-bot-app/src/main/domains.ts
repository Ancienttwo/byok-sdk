import type { MethodHandlers } from '../bridge/domain.ts';
import type { SettingsMethods } from '../bridge/domains/settings.ts';
import { BridgeError, type BridgeMethods, type MainMethod } from '../bridge/protocol.ts';
import { keysMainHandlers, type KeysMainDependencies } from '../custody/main-handlers.ts';
import { shellHandlers, type ShellDependencies } from './recovery.ts';
import { loginItem, setLoginItem } from './tray.ts';

/** What main's own handlers need from main: the Host bridge, the Host executable, and the Host's supervision and stores for recovery. */
export type MainDependencies = KeysMainDependencies & ShellDependencies;

/**
 * Main's answers to the renderer methods a bridge domain lists as `main`. A
 * domain that adds one fails to compile until its handler is connected here.
 */
export function createMainHandlers(deps: MainDependencies): MethodHandlers<Pick<BridgeMethods, MainMethod>> {
  return { ...keysMainHandlers(deps), ...loginItemHandlers(), ...shellHandlers(deps) };
}

/** The login item lives in the OS, so main answers it; the renderer's switch is the only writer. */
function loginItemHandlers(): MethodHandlers<Pick<SettingsMethods, 'settings.loginItem' | 'settings.setLoginItem'>> {
  return {
    'settings.loginItem': () => loginItem(),
    'settings.setLoginItem': params => {
      const enabled = (params as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== 'boolean') throw new BridgeError('invalid_params', 'settings.setLoginItem needs { enabled: boolean }');
      setLoginItem(enabled);
      return loginItem();
    },
  };
}
