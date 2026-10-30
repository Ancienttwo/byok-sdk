// #1097: the installer half of an App that ships the byok-agent bundle as its
// background service. The App verifies a downloaded payload's signature (not
// shown: download, channel and signing stay with the Host), then hands the
// payload directory to the SDK, which stages, prechecks, snapshots, switches,
// health-checks and rolls back. `byok-agent install --payload` and
// `byok-agent upgrade` use the same createServiceInstallation; this App only
// records itself as a different lifecycle owner.
//
//   node app-installer.ts <install|upgrade|rollback|recover|uninstall|status> --config <path> --install-root <dir>
//     [--payload <dir>] [--name <svc>] [--winsw-bin <exe>] [--winsw-install-dir <dir>]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { agentServiceInstallation, createServiceInstallation, ServiceInstallationError, type DaemonConfig } from '@byok-sdk/client';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' }, 'install-root': { type: 'string' }, payload: { type: 'string' }, name: { type: 'string' },
    'winsw-bin': { type: 'string' }, 'winsw-install-dir': { type: 'string' },
  },
});
const [action] = positionals;
if (values.config === undefined || values['install-root'] === undefined) throw new Error('--config and --install-root are required');

const configPath = path.resolve(values.config);
const config = JSON.parse(readFileSync(configPath, 'utf8')) as Pick<DaemonConfig, 'productId' | 'productName' | 'storeDir' | 'branding'>;
const winswBin = values['winsw-bin'];
const installation = createServiceInstallation(agentServiceInstallation({
  config,
  configPath,
  installRoot: path.resolve(values['install-root']),
  owner: 'app',
  ...(values.name === undefined ? {} : { name: values.name }),
  ...(winswBin === undefined ? {} : { windows: { winswBin, ...(values['winsw-install-dir'] ? { installDir: values['winsw-install-dir'] } : {}) } }),
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
