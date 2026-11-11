/**
 * The bridge test's Host child: answers the bridge with no SDK composed behind
 * it. stdout carries only bridge lines, so diagnostics go to stderr.
 */
import { serveBridge } from './server.ts';

serveBridge({
  greeted: () => {},
  status: () => ({ state: 'running', pid: process.pid, activeWork: 0 }),
  shutdown: async () => {},
}).catch((error: Error) => {
  console.error(`Host bridge stopped: ${error.message}`);
  process.exitCode = 1;
});
