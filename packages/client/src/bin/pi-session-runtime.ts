import { AsyncLocalStorage } from 'node:async_hooks';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { acquirePiSessionDiscovery, acquirePiSessionRebinding, acquirePiSessionWriter, type PiSessionRetentionLease } from '../util/pi-session-retention';
import { resolvePathWithoutCreate, type PathMutationGate } from '../util/path-mutation-gate';
import {
  createAgentSession, createAgentSessionRuntime, createAgentSessionServices, createCodingTools,
  getAgentDir, ModelRuntime, resolveCliModel, runRpcMode, SessionManager, SettingsManager,
  type CreateAgentSessionOptions, type CreateAgentSessionResult, type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';

function fail(message: string): never { throw new Error(`byok-pi-rpc: ${message}`); }

/** Native path normalization only: no file is opened and no session identity is claimed. */
function resolveNativePiSessionPath(raw: string): string {
  return SessionManager.inMemory(raw).getCwd();
}

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

/** The loadout view a scoped-session assertion needs; structural so tests can fake it. */
export interface PiToolLoadoutSession {
  getAllTools(): readonly { readonly name: string; readonly sourceInfo?: { readonly path?: string } }[];
  getActiveToolNames(): readonly string[];
}

/** One native session/services assembly for strict daemon RPC and operator CLI. */
export async function runPiSessionRuntime(options: {
  cwd: string; session?: string; sessionDir?: string;
  provider?: string; model?: string;
  thinking?: CreateAgentSessionOptions['thinkingLevel'];
  tools?: string[]; excludeTools?: string[]; noTools?: 'all' | 'builtin';
  /** Pre-prompt registry assertion for a scoped session; throwing disposes and refuses to run. */
  assertToolLoadout?: (session: PiToolLoadoutSession) => void;
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
  // The writer owns its socket, independently of the adapter process. A dead
  // adapter must not make a still-running Pi transcript eligible for deletion.
  const writers = new Map<string, PiSessionRetentionLease>();
  const discoveryGates = new Map<string, { gate: PathMutationGate; references: number }>();
  const replacementContext = new AsyncLocalStorage<{ active: boolean; releaseDiscovery(): Promise<void> }>();
  let rebinding: { gate: PathMutationGate; references: number } | undefined;
  const retainRebinding = async (): Promise<() => Promise<void>> => {
    // A nested withSession/setup belongs to the same mutation. Reuse its one
    // path-gate authority instead of trying to acquire our own socket again.
    if (rebinding === undefined) rebinding = { gate: await acquirePiSessionRebinding(15_000), references: 0 };
    rebinding.references += 1;
    let released = false;
    return async () => {
      if (released) return;
      if (rebinding!.references === 1) { await rebinding!.gate.release(); rebinding = undefined; }
      else rebinding!.references -= 1;
      released = true;
    };
  };
  const discover = async (directories: readonly string[]): Promise<() => Promise<void>> => {
    const held: string[] = [];
    const release = async (): Promise<void> => {
      while (held.length > 0) {
        const directory = held[held.length - 1]!, entry = discoveryGates.get(directory)!;
        if (entry.references === 1) { await entry.gate.release(); discoveryGates.delete(directory); }
        else entry.references -= 1;
        held.pop();
      }
    };
    if (options.sessionDir === undefined) return release;
    const canonical = [...new Set(await Promise.all(directories.map(resolvePathWithoutCreate)))].sort();
    try {
      for (const directory of canonical) {
        const existing = discoveryGates.get(directory);
        if (existing !== undefined) existing.references += 1;
        else discoveryGates.set(directory, { gate: await acquirePiSessionDiscovery(directory, 15_000), references: 1 });
        held.push(directory);
      }
      return release;
    } catch (error) { await release(); throw error; }
  };
  const retainWriter = async (manager: SessionManager): Promise<string> => {
    const file = manager.getSessionFile();
    if (file === undefined) options.reject('retained Pi runtime requires a persisted session');
    const canonical = await resolvePathWithoutCreate(file);
    if (!writers.has(canonical)) writers.set(canonical, await acquirePiSessionWriter(canonical));
    return canonical;
  };
  const retireWriters = async (current: string): Promise<void> => {
    for (const [file, lease] of writers) if (file !== current) {
      await lease.release(); writers.delete(file);
    }
  };
  const releaseInitialDiscovery = await discover([...(options.sessionDir === undefined ? [] : [options.sessionDir]),
    ...(options.session !== undefined && isAbsolute(options.session) ? [dirname(options.session)] : [])]);
  let sessionManager: SessionManager;
  try {
    sessionManager = await openPiRpcSession(options.cwd, options.session, options.sessionDir ?? initialSettings.getSessionDir(), options.reject);
  } catch (error) { await releaseInitialDiscovery(); throw error; }
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    if (cwd !== options.cwd || sessionManager.getCwd() !== options.cwd) options.reject('session replacement cannot change authorized cwd');
    if (options.sessionDir !== undefined) {
      await retainWriter(sessionManager);
      // The file now has its writer gate. Model loading and agent turns do
      // not hold the directory discovery barrier.
      await (replacementContext.getStore()?.releaseDiscovery() ?? releaseInitialDiscovery());
    }
    // The excluded resource loader has no user/global/project settings. Its
    // model runtime independently opens only Pi's model/auth stores, and it
    // keeps the user's global model selection (#1296).
    const isolated = options.resourceAgentDir !== undefined;
    const selection = isolated ? SettingsManager.create(options.cwd, credentialAgentDir, { projectTrusted: false }) : undefined;
    const newSession = sessionManager.buildSessionContext().messages.length === 0;
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
      settingsManager: selection !== undefined
        ? SettingsManager.inMemory({
          defaultProvider: selection.getDefaultProvider(), defaultModel: selection.getDefaultModel(),
          defaultThinkingLevel: selection.getDefaultThinkingLevel(),
        }, { projectTrusted: false })
        : SettingsManager.create(options.cwd, agentDir, { projectTrusted: true }),
      resourceLoaderOptions: options.resourceLoaderOptions,
    });
    const extensions = services.resourceLoader.getExtensions();
    const errors = [
      ...services.diagnostics.filter(diagnostic => diagnostic.type === 'error').map(diagnostic => diagnostic.message),
      ...extensions.errors.map(({ path, error }) => `${path}: ${error}`),
    ];
    if (errors.length > 0) options.reject(errors.join('\n'));
    const loaded = new Set(extensions.extensions.map(extension => extension.path));
    for (const input of options.resourceLoaderOptions?.extensionFactories ?? []) {
      if (typeof input !== 'function' && input.replaceable === true && !loaded.has(`<inline:${input.name}>`)) {
        process.stderr.write(`${options.label}: another extension registers a name of bundled ${input.name}, so Pi did not load ${input.name}\n`);
      }
    }
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
    if (options.assertToolLoadout !== undefined) {
      try {
        options.assertToolLoadout(created.session);
      } catch (error) {
        created.session.dispose();
        throw error;
      }
    }
    // Without the settings default Pi would take the first provider that has
    // any key, including one only the environment supplies. A resumed session
    // keeps its recorded model, or Pi reports a fallback below.
    if (selection !== undefined && options.model === undefined && newSession
      && (created.session.model?.provider !== selection.getDefaultProvider() || created.session.model?.id !== selection.getDefaultModel())) {
      await created.session.dispose();
      options.reject('excluded user context starts a new session only on the defaultProvider and defaultModel of Pi settings, which must name a model with configured auth, or on an explicit model');
    }
    if (created.modelFallbackMessage && options.initialModel === 'required') {
      await created.session.dispose();
      options.reject(created.modelFallbackMessage);
    }
    if (created.session.model && (options.thinking !== undefined || resolved?.thinkingLevel !== undefined)) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }
    return { ...created, services, diagnostics: services.diagnostics };
  };
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  try {
    runtime = await createAgentSessionRuntime(createRuntime, { cwd: options.cwd, agentDir, sessionManager });
  } finally { await releaseInitialDiscovery(); }
  if (options.sessionDir !== undefined) {
    // Native replacement opens/creates the next SessionManager BEFORE invoking
    // createRuntime. Guard that interval too, including foreign-directory
    // switch targets. Serialize replacements only within this one host.
    let replacementTail: Promise<unknown> = Promise.resolve();
    const replace = <T>(extraDirectories: readonly string[], action: () => Promise<T>): Promise<T> => {
      const run = async (): Promise<T> => {
        const releaseDiscovery = await discover([runtime.session.sessionManager.getSessionDir(), ...extraDirectories]);
        const context = {active:true, releaseDiscovery};
        return replacementContext.run(context, async () => {
          try {
            const result = await action();
            // Native replacement disposed the outgoing session and finished
            // setup/withSession callbacks. Its final file may differ from the
            // factory's file, and a withSession callback may replace it again.
            await retireWriters(await retainWriter(runtime.session.sessionManager));
            return result;
          } finally { context.active = false; await releaseDiscovery(); }
        });
      };
      // withSession can recursively request another replacement. It belongs to
      // this operation and must not wait on its own receipt; independent RPC
      // requests still execute in order within this host.
      if (replacementContext.getStore()?.active === true) return run();
      const pending = replacementTail.then(run);
      replacementTail = pending.catch(() => undefined);
      return pending;
    };
    const switchSession = runtime.switchSession.bind(runtime);
    runtime.switchSession = (...args) => {
      // Reuse Pi's public in-memory constructor solely for native path
      // normalization (relative, tilde, file URL, platform conventions). It
      // does not open a file and is never a session-identity authority.
      const normalized = resolveNativePiSessionPath(args[0]);
      return replace([dirname(normalized)], () => switchSession(...args));
    };
    const newSession = runtime.newSession.bind(runtime);
    runtime.newSession = (input) => {
      const setup = input?.setup;
      const guarded = setup === undefined ? input : { ...input, setup: async (manager: SessionManager) => {
        // Unlike withSession's readonly context, setup receives the mutable
        // manager and can replace its file after createRuntime has returned.
        const releaseRebinding = await retainRebinding();
        try { await setup(manager); }
        finally {
          // Native already applied this manager, even if setup throws. Its
          // synchronous setter can move to an arbitrary directory before an
          // await, so only this callback holds the global Pi rebinding barrier.
          // A failed writer acquisition retains protection until host disposal.
          await retainWriter(manager);
          await releaseRebinding();
        }
      } };
      return replace([], () => newSession(guarded));
    };
    const fork = runtime.fork.bind(runtime);
    runtime.fork = (...args) => replace([], () => fork(...args));
    const importFromJsonl = runtime.importFromJsonl.bind(runtime);
    runtime.importFromJsonl = (...args) => replace([dirname(resolveNativePiSessionPath(args[0]))], () => importFromJsonl(...args));
    const dispose = runtime.dispose.bind(runtime);
    runtime.dispose = async () => {
      await replacementTail;
      await dispose();
      for (const [file, lease] of writers) { await lease.release(); writers.delete(file); }
      if (rebinding !== undefined) { await rebinding.gate.release(); rebinding = undefined; }
    };
  }
  await runRpcMode(runtime);
}
