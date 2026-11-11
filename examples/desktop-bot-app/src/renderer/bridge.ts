import type { BridgeIpc, ByokBridge } from '../bridge/protocol.ts';

/** A refused bridge call, with the code the refusing handler gave it (`invalid_params`, a custody or keys code, ...). */
export class BridgeCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeCallError';
    this.code = code;
  }
}

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
