// A sandboxed preload may require only Electron's own modules, so the bridge
// protocol arrives here as types; main enforces the method allowlist.
import type { BRIDGE_IPC_CHANNEL, BridgeIpc, STATE_HINT_CHANNEL } from '../bridge/protocol.ts';

const { contextBridge, ipcRenderer }: typeof import('electron') = require('electron');
const channel: typeof BRIDGE_IPC_CHANNEL = 'byok:bridge';
const hintChannel: typeof STATE_HINT_CHANNEL = 'byok:state-changed';

// Main resolves every call to a BridgeOutcome; the renderer root turns a refusal into an error with its code.
const bridge: BridgeIpc = {
  invoke: (method, params) => ipcRenderer.invoke(channel, method, params),
  // The renderer never sees the IPC event; the hint has no payload.
  onStateChanged: listener => {
    const handler = () => listener();
    ipcRenderer.on(hintChannel, handler);
    return () => { ipcRenderer.removeListener(hintChannel, handler); };
  },
};

contextBridge.exposeInMainWorld('byokIpc', bridge);
