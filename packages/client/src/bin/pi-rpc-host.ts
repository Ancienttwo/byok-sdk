import { extractPiConfigDigest, readPiHostConfig } from '../adapters/pi/runtime-host-binding';
import { isAbsolute, resolve } from 'node:path';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { runPiSessionRuntime } from './pi-session-runtime';
export { openPiRpcSession } from './pi-session-runtime';
import { webExtension, subagentsExtension } from './pi-extension-factories.js';
import { bundledAssetRoot, verifyTodoLocaleAssets } from '../adapters/pi/todo-locale-assets';
import { createByokMcpExtension } from '../adapters/pi/mcp-extension';
import { parseTaskScopedMcpConfig, type TaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool';

export interface PiRpcHostConfig {
  readonly format: 'byok.pi.rpc-launch';
  readonly version: 4;
  /** The session cwd. */
  readonly cwd: string;
  readonly mcp: TaskScopedMcpConfig;
}

type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;
interface PiRpcHostArgs {
  configPath: string;
  configDigest: string;
  session?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

function fail(message: string): never {
  throw new Error(`byok-pi-rpc: ${message}`);
}

/** A callable host owns CLI usage errors; thin bins must not reformat them. */
function failUsage(message: string): never {
  process.stderr.write(`byok-pi-rpc: ${message}\n`);
  process.exit(78); // EX_CONFIG, identical to the prepared helper contract.
}

export function parsePiRpcHostConfig(value: unknown): PiRpcHostConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('config must be an object');
  const raw = value as Record<string, unknown>;
  const keys = ['format', 'version', 'cwd', 'mcp'];
  if (Object.keys(raw).some((key) => !keys.includes(key)) || keys.some((key) => !(key in raw))) {
    fail('config must contain exactly format, version, cwd, mcp');
  }
  if (raw.format !== 'byok.pi.rpc-launch' || raw.version !== 4) fail('unsupported config format/version');
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || resolve(raw.cwd) !== raw.cwd) {
    fail('config.cwd must be a normalized absolute path');
  }
  const mcp = parseTaskScopedMcpConfig(raw.mcp, fail);
  return { format: 'byok.pi.rpc-launch', version: 4, cwd: raw.cwd, mcp };
}

export function parsePiRpcHostArgs(
  argv: readonly string[], reject: (message: string) => never = fail,
): PiRpcHostArgs {
  const owned = extractPiConfigDigest(argv, reject);
  argv = owned.args;
  const values = new Map<string, string>();
  const valued = new Set(['--config', '--mode', '--session', '--provider', '--model', '--thinking']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (values.has(flag)) reject(`duplicate argument ${flag}`);
    if (!valued.has(flag)) reject(`unsupported argument ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) reject(`${flag} requires a value`);
    values.set(flag, value);
  }
  const configPath = values.get('--config');
  if (!configPath || !isAbsolute(configPath)) reject('--config must be an absolute path');
  if (values.get('--mode') !== 'rpc') reject('--mode rpc is required');
  const thinking = values.get('--thinking');
  if (thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) {
    reject('invalid --thinking level');
  }
  if (values.has('--provider') && !values.has('--model')) reject('--provider requires --model');
  return {
    configPath, configDigest: owned.digest,
    session: values.get('--session'), provider: values.get('--provider'), model: values.get('--model'),
    thinking: thinking as ThinkingLevel | undefined,
  };
}

/**
 * `packaging` is `bundled` when a single-file product re-enters through the
 * SDK-reserved helper; its assets then live in its Pi asset root.
 */
export async function runPiRpcHost(argv: readonly string[], packaging: 'installed' | 'bundled' = 'installed'): Promise<void> {
  const args = parsePiRpcHostArgs(argv, failUsage);
  const config = parsePiRpcHostConfig(readPiHostConfig(args.configPath, args.configDigest));
  const localeAnchor = packaging === 'bundled' ? verifyTodoLocaleAssets(bundledAssetRoot) : verifyTodoLocaleAssets();
  const { createTodoExtension } = await import('#byok-pi-todo-runtime');
  const todoExtension = createTodoExtension(localeAnchor);
  await runPiSessionRuntime({
    cwd: config.cwd, session: args.session,
    provider: args.provider, model: args.model, thinking: args.thinking,
    // The user's own Pi extensions and skills load beside the SDK's own, as in
    // OAR: the SDK does not presume how the user configures Pi.
    resourceLoaderOptions: {
      extensionFactories: [webExtension, createByokMcpExtension(config.mcp), subagentsExtension, todoExtension],
    },
    initialModel: 'required', label: 'byok-pi-rpc', reject: fail,
  });
}
