// #1097: the installer half of an App that ships the byok-agent bundle as its
// background service. The App verifies a downloaded payload's signature (not
// shown: download, channel and signing stay with the Host), then hands the
// payload directory to the SDK, which stages, prechecks, snapshots, switches,
// health-checks and rolls back. `byok-agent install --payload` and
// `byok-agent upgrade` use the same createServiceInstallation; this App only
// records itself as a different lifecycle owner.
//
// On Windows the App either registers a WinSW service (--winsw-bin, needs an
// administrator) or autostarts at the user's logon (--windows-user, #1337).
// A `user` scope service needs the Host's own stop program; this App's is its
// `stop-daemon` action. After `uninstall`, `clear-enrollment` removes the
// store's device enrollment from this account's OS credential set with
// clearDeviceEnrollment and prints the status read back; the store directory
// stays.
//
//   node app-installer.ts <install|upgrade|rollback|recover|uninstall|status|stop-daemon|clear-enrollment> --config <path> --install-root <dir>
//     [--payload <dir>] [--name <svc>] [--winsw-bin <exe> [--winsw-install-dir <dir>] | --windows-user]
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  agentServiceDefinition, agentServiceInstallation, clearDeviceEnrollment, createServiceInstallation, DeviceEnrollmentClearError,
  readDeviceEnrollmentStatus, ServiceInstallationError, type DaemonConfig, type ServiceWindowsOptions,
} from '@byok-sdk/client';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' }, 'install-root': { type: 'string' }, payload: { type: 'string' }, name: { type: 'string' },
    'winsw-bin': { type: 'string' }, 'winsw-install-dir': { type: 'string' }, 'windows-user': { type: 'boolean' },
  },
});
const [action] = positionals;
if (values.config === undefined || values['install-root'] === undefined) throw new Error('--config and --install-root are required');

const configPath = path.resolve(values.config);
const config = JSON.parse(readFileSync(configPath, 'utf8')) as Pick<DaemonConfig, 'productId' | 'productName' | 'storeDir' | 'branding' | 'nativeAssetRoot'>;

/**
 * The `user` scope service's stop program: ends the daemon that owns the
 * store and exits 0 when none does. A Host with its own control client sends
 * the daemon `shutdown` instead; this example has none, so it terminates the
 * process, and the installation's owner lease reclaims what that leaves.
 */
async function stopDaemon(): Promise<void> {
  const { storeDir } = agentServiceDefinition({ config, configPath, agentBin: 'byok-agent.mjs', owner: 'app' });
  let owner: { role?: string; pid?: number };
  try {
    owner = JSON.parse(await readFile(path.join(storeDir, 'daemon-owner.json'), 'utf8')) as typeof owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (owner.role !== 'daemon' || typeof owner.pid !== 'number') return;
  try {
    process.kill(owner.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

if (action === 'stop-daemon') {
  await stopDaemon();
  process.exit(0);
}

if (action === 'clear-enrollment') {
  const { storeDir } = agentServiceDefinition({ config, configPath, agentBin: 'byok-agent.mjs', owner: 'app' });
  const enrollment = {
    productId: config.productId, storeDir, ...(config.nativeAssetRoot === undefined ? {} : { nativeAssetRoot: config.nativeAssetRoot }),
  };
  try {
    await clearDeviceEnrollment(enrollment);
    console.log(JSON.stringify(await readDeviceEnrollmentStatus(enrollment)));
  } catch (error) {
    // A live owner of the store or another store's enrollment is an answer for the App's user.
    if (!(error instanceof DeviceEnrollmentClearError) || error.code === 'clear_failed') throw error;
    console.log(JSON.stringify({ error: error.code }));
    process.exit(3);
  }
  process.exit(0);
}

const installRoot = path.resolve(values['install-root']);
const winswBin = values['winsw-bin'];
const windows: ServiceWindowsOptions | undefined = values['windows-user'] === true
  ? { scope: 'user', stop: { command: process.execPath, args: [path.resolve(process.argv[1]!), 'stop-daemon', '--config', configPath, '--install-root', installRoot] } }
  : winswBin === undefined ? undefined : { winswBin, ...(values['winsw-install-dir'] ? { installDir: values['winsw-install-dir'] } : {}) };
const installation = createServiceInstallation(agentServiceInstallation({
  config,
  configPath,
  installRoot,
  owner: 'app',
  ...(values.name === undefined ? {} : { name: values.name }),
  ...(windows === undefined ? {} : { windows }),
}));


function payload(): string {
  if (values.payload === undefined) throw new Error(`${action} requires --payload <dir>`);
  return path.resolve(values.payload);
}

try {
  switch (action) {
    case 'install':
      await installation.install(payload());
      break;
    case 'upgrade':
      await installation.upgrade(payload());
      break;
    case 'rollback':
      await installation.rollback();
      break;
    case 'recover':
      await installation.recover();
      break;
    case 'uninstall':
      await installation.uninstall();
      break;
    case 'status':
      break;
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`);
  }
  console.log(JSON.stringify({ current: (await installation.currentVersion()) ?? null, receipt: (await installation.receipt()) ?? null }));
} catch (error) {
  // A store refusal or a failed health check is an answer the App shows its user, with the receipt.
  if (!(error instanceof ServiceInstallationError)) throw error;
  console.log(JSON.stringify({ error: error.code, stores: error.stores ?? null, receipt: (await installation.receipt()) ?? null }));
  process.exitCode = 3;
}
