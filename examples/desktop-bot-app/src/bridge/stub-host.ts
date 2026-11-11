/**
 * Dev-mode Host child: answers the bridge with no SDK composed behind it.
 * Main runs it under Node; #1805 replaces it with the composed Host.
 * stdout carries only bridge lines, so diagnostics go to stderr.
 */
import { serveBridge } from './server.ts';

serveBridge({
  status: () => ({ state: 'running', pid: process.pid }),
  shutdown: async () => {},
}).catch((error: Error) => {
  console.error(`Host bridge stopped: ${error.message}`);
  process.exitCode = 1;
});
