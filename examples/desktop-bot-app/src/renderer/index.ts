// Empty renderer: shows the Host state read over the bridge. The conversation UI arrives with #1807.
import type { ByokBridge } from '../bridge/protocol.ts';

declare global {
  interface Window { readonly byok: ByokBridge }
}

const root = document.getElementById('app');
if (root) {
  window.byok.call('status', undefined).then(
    status => { root.textContent = `Host ${status.state}`; },
    (error: Error) => { root.textContent = `Host unavailable: ${error.message}`; },
  );
}
