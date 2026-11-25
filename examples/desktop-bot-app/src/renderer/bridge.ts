import type { BridgeIpc, ByokBridge } from '../bridge/protocol.ts';
import { BridgeCallError } from '../bridge/error.ts';

export { BridgeCallError };

/** `window.byok` over the preload's raw IPC: a call resolves to its value or rejects with a {@link BridgeCallError}. */
export function rendererBridge(ipc: BridgeIpc): ByokBridge {
  return {
    call: async (method, params) => {
      const outcome = await ipc.invoke(method, params);
      if (!outcome.ok) throw new BridgeCallError(outcome.code, outcome.message);
      return outcome.value as never;
    },
    onStateChanged: listener => ipc.onStateChanged(listener),
  };
}
