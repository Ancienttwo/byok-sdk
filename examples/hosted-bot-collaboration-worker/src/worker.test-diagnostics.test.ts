import { describe, expect, it } from 'vitest';
import { proxyDiagnostics } from './worker.test-diagnostics';

describe('Worker proxy diagnostics', () => {
  it('retains recovered requests and disconnect lines without interpreting them as test failures', () => {
    const recovery = 'ProxyWorker: GET http://localhost/ recovered on attempt 2 after a dropped connection to the UserWorker';
    const disconnect = 'Error: Network connection lost.';
    expect(proxyDiagnostics(`\u001b[33m${recovery}\u001b[0m\r\n${disconnect}\nready\n`)).toEqual({
      recoveries: [recovery], disconnects: [disconnect],
    });
  });

  it('reports quiet runs as zero and counts diagnostic lines rather than claiming unique outages', () => {
    expect(proxyDiagnostics('Ready on http://127.0.0.1:1234\n')).toEqual({ recoveries: [], disconnects: [] });
    expect(proxyDiagnostics('Network connection lost\nstream disconnected prematurely\n').disconnects).toHaveLength(2);
  });
});
