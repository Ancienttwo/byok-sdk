import { createDaemonWithAdapters } from '../../daemon/create-daemon';
import { resolveAgentMemoryFilesystemHelper } from '../../util/agent-memory-helper-release';

const root = process.argv[2]!;
const config = {
  productName: 'Memory availability', productId: 'memory-availability',
  serverUrl: 'http://localhost:1', storeDir: `${root}/store`,
  localAgentRelease: { version: '0.0.0-test' }, agentHome: { hostStorageRoot: `${root}/homes` },
  sdkHelperHost: { mode: 'self-executable' as const },
};
createDaemonWithAdapters(config, []);
let memoryAdmitted = false;
let memoryError: string | undefined;
try { createDaemonWithAdapters({ ...config, agentMemory: {} }, []); memoryAdmitted = true; }
catch (error) { memoryError = String(error); }
let assetError: string | undefined;
try { resolveAgentMemoryFilesystemHelper(); }
catch (error) { assetError = String(error); }
console.log(JSON.stringify({ plainDaemonAdmitted: true, memoryAdmitted, memoryError, assetError }));
