// The renderer root: builds `window.byok` over the preload's IPC, then mounts the shell. Features live in shell/slots.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BridgeIpc, ByokBridge } from '../bridge/protocol.ts';
import { rendererBridge } from './bridge.ts';
import { Shell } from './shell/shell.tsx';
import './theme/tokens.css';

declare global {
  interface Window { readonly byok: ByokBridge; readonly byokIpc: BridgeIpc }
}

Object.defineProperty(window, 'byok', { value: rendererBridge(window.byokIpc) });

const root = document.getElementById('app');
if (!root) throw new Error('index.html has no #app element');
createRoot(root).render(<StrictMode><Shell /></StrictMode>);
