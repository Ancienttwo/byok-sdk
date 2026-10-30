import path from 'node:path';
import type { DaemonConfig } from '../daemon/create-daemon';
import { serviceLogDir } from '../daemon/host-layout';
import { DeviceStore } from '../daemon/store';
import type { ServiceInstallationOptions } from './service-installation';
import { nodeAgentProgram, type ServiceDefinition } from './service-types';

export interface AgentServiceDefinitionInput {
  config: Pick<DaemonConfig, 'productId' | 'productName' | 'storeDir' | 'branding'>;
  /** The config file `byok-agent start` loads; resolved to an absolute path, since the service starts in the manager's own working directory. */
  configPath: string;
  /** Absolute path of the `byok-agent` entry script. */
  agentBin: string;
  /** Node executable that runs `agentBin`. Default: `process.execPath`. */
  nodeBin?: string;
  /** See {@link ServiceDefinition.owner}. */
  owner: string;
  /** Default: `config.productId`. */
  name?: string;
  windows?: ServiceDefinition['windows'];
}

/**
 * The service definition for `node <agentBin> start --config <configPath>
 * --service` (#1097): the one implementation `byok-agent install` and an
 * embedded Host share. Every default derives from `config`, so install,
 * uninstall and status compute the same name, store and log directory.
 *
 * `--service` makes `start` capture the login-shell environment (#392) and
 * exit 0 on a halt (#394, `exit-codes.ts`). The log directory is
 * `resolveHostLayout`'s `logDir` for this store.
 */
export function agentServiceDefinition(input: AgentServiceDefinitionInput): ServiceDefinition {
  const storeDir = DeviceStore.resolveDir(input.config.productId, input.config.storeDir);
  const definition: ServiceDefinition = {
    name: input.name ?? input.config.productId,
    displayName: input.config.branding?.displayName ?? input.config.productName,
    program: nodeAgentProgram({ agentBin: input.agentBin, configPath: path.resolve(input.configPath), nodeBin: input.nodeBin, service: true }),
    storeDir,
    logDir: serviceLogDir(storeDir),
    owner: input.owner,
  };
  if (input.windows) definition.windows = input.windows;
  return definition;
}

/** The entry a `byok-agent` payload ships at its root: a single-file bundle (`@byok-sdk/client/packaging`). */
export const AGENT_PAYLOAD_ENTRY = 'byok-agent.mjs';

export interface AgentServiceInstallationInput extends Omit<AgentServiceDefinitionInput, 'agentBin'> {
  /** See {@link ServiceInstallationOptions.installRoot}. */
  installRoot: string;
}

/**
 * The installation of a `byok-agent` payload (#1097): `byok-agent install
 * --payload` and an embedded Host that ships the agent bundle share it. The
 * service runs `node <installRoot>/current/byok-agent.mjs start --config
 * <configPath> --service`; the precheck runs the candidate's own `upgrade
 * check --store --json` against the same config.
 */
export function agentServiceInstallation(input: AgentServiceInstallationInput): ServiceInstallationOptions {
  const { program: _program, ...service } = agentServiceDefinition({ ...input, agentBin: AGENT_PAYLOAD_ENTRY });
  const configPath = path.resolve(input.configPath);
  const nodeBin = input.nodeBin ?? process.execPath;
  return {
    service,
    productId: input.config.productId,
    installRoot: input.installRoot,
    program: (versionDir) => nodeAgentProgram({ agentBin: path.join(versionDir, AGENT_PAYLOAD_ENTRY), configPath, nodeBin, service: true }),
    precheck: (versionDir) => ({ command: nodeBin, args: [path.join(versionDir, AGENT_PAYLOAD_ENTRY), 'upgrade', 'check', '--store', '--json', '--config', configPath] }),
  };
}
