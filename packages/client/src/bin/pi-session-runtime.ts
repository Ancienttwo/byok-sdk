import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  createAgentSession, createAgentSessionRuntime, createAgentSessionServices, createCodingTools,
  getAgentDir, ModelRuntime, resolveCliModel, runRpcMode, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type CreateAgentSessionResult, type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';

function fail(message: string): never { throw new Error(`byok-pi-rpc: ${message}`); }

/**
 * Pi 1.4 restores a resumed transcript's recorded tool loadout. It activates
 * an extension tool the transcript never mentioned, but it keeps the recorded
 * built-in tools instead of the current `defaultTools`, and it reactivates a
 * declared extension tool that now registers default-inactive, deferred or
 * codemode. As OAR 0.67 does (#416), reset a resumed default-tools session to
 * the current native defaults and default-active extension tools before
 * `session_start`, so it offers the same tools as a new session with the same
 * options. Pi still applies `excludeTools` and exposure rules.
 *
 * The restore also keeps the transcript's not-yet-registered tools pending,
 * and a registration during `session_start` would activate them. Pi drops
 * pending tools only when a call deactivates an active tool, so the reset
 * activates every registered tool, empties the set, then sets the loadout.
 * When Pi activates none of them, it offers no way to drop the pending tools,
 * so the open fails.
 */
export function resetResumedPiTools(
  session: CreateAgentSessionResult['session'], settingsManager: SettingsManager, cwd: string,
): void {
  if (session.sessionManager.buildSessionContext().messages.length === 0) return;
  const registered = session.getAllTools();
  const defaults = settingsManager.getDefaultTools() ?? createCodingTools(cwd).map((tool) => tool.name);
  const extensions = registered.filter((tool) =>
    tool.sourceInfo.path !== `builtin:${tool.name}`
    && session.getToolDefinition(tool.name)?.defaultActive !== false
    && (tool.exposure === 'direct' || tool.exposure === 'model-only'));
  session.setActiveToolsByName(registered.map((tool) => tool.name));
  if (session.getActiveToolNames().length === 0) throw new Error('a resumed Pi session with no activatable tool cannot drop its restored pending tools');
  session.setActiveToolsByName([]);
  session.setActiveToolsByName([...defaults, ...extensions.map((tool) => tool.name)]);
}

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
  /** Fresh SDK-owned resources directory. The original Pi directory remains the model/auth authority. */
  resourceAgentDir?: string;
  /**
   * A launcher-delivered key, handed to Pi only in memory. It lives in the
   * model runtime's non-persistent overlay, never in this process's
   * environment, so no tool shell this session spawns can inherit it.
   */
  providerApiKey?: { readonly provider: string; readonly apiKey: string };
  resourceLoaderOptions: NonNullable<Parameters<typeof createAgentSessionServices>[0]>['resourceLoaderOptions'];
  /** The CLI RPC contract permits no-model startup; daemon admission does not. */
  initialModel: 'required' | 'on-prompt';
  label: string; reject: (message: string) => never;
}): Promise<void> {
  const credentialAgentDir = getAgentDir();
  const agentDir = options.resourceAgentDir ?? credentialAgentDir;
  const initialSettings = SettingsManager.create(options.cwd, credentialAgentDir);
  const sessionManager = await openPiRpcSession(options.cwd, options.session, options.sessionDir ?? initialSettings.getSessionDir(), options.reject);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    if (cwd !== options.cwd || sessionManager.getCwd() !== options.cwd) options.reject('session replacement cannot change authorized cwd');
    // The excluded resource loader has no user/global/project settings. Its
    // model runtime independently opens only Pi's model/auth stores.
    const isolated = options.resourceAgentDir !== undefined;
    const modelRuntime = isolated ? await ModelRuntime.create({
      authPath: join(credentialAgentDir, 'auth.json'),
      modelsPath: join(credentialAgentDir, 'models.json'),
      signal: AbortSignal.timeout(15_000),
    }) : undefined;
    // Pi reports a missing explicit skill as a warning and continues without it.
    // Require readable grants without promoting unrelated advisory diagnostics.
    for (const path of options.resourceLoaderOptions?.additionalSkillPaths ?? []) {
      await access(path, constants.R_OK);
    }
    const services = await createAgentSessionServices({
      cwd: options.cwd, agentDir, modelRuntimeSignal: AbortSignal.timeout(15_000),
      ...(modelRuntime === undefined ? {} : { modelRuntime }),
      settingsManager: isolated
        ? SettingsManager.inMemory({}, { projectTrusted: false })
        : SettingsManager.create(options.cwd, agentDir, { projectTrusted: true }),
      resourceLoaderOptions: options.resourceLoaderOptions,
    });
    const errors = [
      ...services.diagnostics.filter(diagnostic => diagnostic.type === 'error').map(diagnostic => diagnostic.message),
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => `${path}: ${error}`),
    ];
    if (errors.length > 0) options.reject(errors.join('\n'));
    if (options.providerApiKey !== undefined) {
      const { provider, apiKey } = options.providerApiKey;
      // A fixed refusal: a foreign error from this call may carry the key.
      const registered = await services.modelRuntime.setRuntimeApiKey(provider, apiKey).then(() => true, () => false);
      if (!registered || services.modelRuntime.getProviderAuthStatus(provider).source !== 'runtime') {
        options.reject('launcher provider key could not be registered in memory');
      }
    }
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
    if (options.tools === undefined && options.noTools === undefined) resetResumedPiTools(created.session, services.settingsManager, options.cwd);
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
