import { isAbsolute } from 'node:path';
import {
  createAgentSession, createAgentSessionRuntime, createAgentSessionServices,
  getAgentDir, resolveCliModel, runRpcMode, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';

function fail(message: string): never { throw new Error(`byok-pi-rpc: ${message}`); }

/** Session ids are native minted references, never fuzzy search terms. */
export async function openPiRpcSession(cwd: string, session: string | undefined, sessionDir?: string, reject: (message: string) => never = fail): Promise<SessionManager> {
  if (session === undefined) return SessionManager.create(cwd, sessionDir);
  let path: string;
  if (isAbsolute(session)) {
    path = session;
  } else {
    const matches = (await SessionManager.list(cwd, sessionDir)).filter((candidate) => candidate.id === session);
    if (matches.length !== 1) reject('--session must identify exactly one existing session');
    path = matches[0]!.path;
  }
  const manager = SessionManager.open(path, sessionDir);
  if (manager.getCwd() !== cwd) reject('session header cwd differs from config.cwd');
  return manager;
}

/** One native session/services assembly for strict daemon RPC and operator CLI. */
export async function runPiSessionRuntime(options: {
  cwd: string; session?: string; sessionDir?: string;
  provider?: string; model?: string;
  thinking?: CreateAgentSessionOptions['thinkingLevel'];
  tools?: string[]; excludeTools?: string[]; noTools?: 'all' | 'builtin';
  resourceLoaderOptions: NonNullable<Parameters<typeof createAgentSessionServices>[0]>['resourceLoaderOptions'];
  /** The CLI RPC contract permits no-model startup; daemon admission does not. */
  initialModel: 'required' | 'on-prompt';
  label: string; reject: (message: string) => never;
}): Promise<void> {
  const agentDir = getAgentDir();
  const initialSettings = SettingsManager.create(options.cwd, agentDir);
  const sessionManager = await openPiRpcSession(options.cwd, options.session, options.sessionDir ?? initialSettings.getSessionDir(), options.reject);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    if (cwd !== options.cwd || sessionManager.getCwd() !== options.cwd) options.reject('session replacement cannot change authorized cwd');
    const services = await createAgentSessionServices({
      cwd: options.cwd, agentDir, modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderOptions: options.resourceLoaderOptions,
    });
    const errors = [
      ...services.diagnostics.filter(diagnostic => diagnostic.type === 'error').map(diagnostic => diagnostic.message),
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => `${path}: ${error}`),
    ];
    if (errors.length > 0) options.reject(errors.join('\n'));
    const resolved = options.model === undefined ? undefined : resolveCliModel({
      cliProvider: options.provider, cliModel: options.model, cliThinking: options.thinking, modelRuntime: services.modelRuntime,
    });
    if (resolved?.error) options.reject(resolved.error);
    if (options.model !== undefined && !resolved?.model) options.reject('requested model could not be resolved');
    if (resolved?.warning) process.stderr.write(`${options.label}: ${resolved.warning}\n`);
    const created = await createAgentSession({
      cwd: options.cwd, agentDir, sessionManager, sessionStartEvent,
      modelRuntime: services.modelRuntime, settingsManager: services.settingsManager, resourceLoader: services.resourceLoader,
      model: resolved?.model, thinkingLevel: options.thinking ?? resolved?.thinkingLevel,
      tools: options.tools, excludeTools: options.excludeTools, noTools: options.noTools,
    });
    if (created.modelFallbackMessage && options.initialModel === 'required') {
      await created.session.dispose();
      options.reject(created.modelFallbackMessage);
    }
    if (created.session.model && (options.thinking !== undefined || resolved?.thinkingLevel !== undefined)) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }
    return { ...created, services, diagnostics: services.diagnostics };
  };
  await runRpcMode(await createAgentSessionRuntime(createRuntime, { cwd: options.cwd, agentDir, sessionManager }));
}
