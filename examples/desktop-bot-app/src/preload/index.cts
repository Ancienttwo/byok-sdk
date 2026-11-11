// A sandboxed preload may require only Electron's own modules, so the bridge
// protocol arrives here as types; main enforces the method allowlist.
import type { BRIDGE_IPC_CHANNEL, ByokBridge } from '../bridge/protocol.ts';

const { contextBridge, ipcRenderer }: typeof import('electron') = require('electron');
const channel: typeof BRIDGE_IPC_CHANNEL = 'byok:bridge';

const bridge: ByokBridge = {
  call: (method, params) => ipcRenderer.invoke(channel, method, params),
};

contextBridge.exposeInMainWorld('byok', bridge);
