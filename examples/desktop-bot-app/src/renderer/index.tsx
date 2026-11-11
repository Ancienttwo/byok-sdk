// The renderer root: mounts the shell. Features live in shell/slots; this file stays as it is.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ByokBridge } from '../bridge/protocol.ts';
import { Shell } from './shell/shell.tsx';
import './theme/tokens.css';

declare global {
  interface Window { readonly byok: ByokBridge }
}

const root = document.getElementById('app');
if (!root) throw new Error('index.html has no #app element');
createRoot(root).render(<StrictMode><Shell /></StrictMode>);
