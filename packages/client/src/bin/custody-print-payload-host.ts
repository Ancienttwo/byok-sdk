/**
 * WP4 print payload host (`custody-print-payload-host`) — the in-bundle leaf
 * executor for a dispatched `pi-subagent-print` child, reached ONLY through
 * the `#byok-pi-runtime-host` seam. This module lives behind that seam on
 * purpose: it statically imports the pi session machinery and the vendored
 * subagents extension, and the runtime-host artifact is the one bundle that
 * already carries them. The library root (`dist/index.js`) must stay free of
 * those external imports even though it statically re-exports the helper
 * host (and therefore the custody entries' payload re-entry points) — the
 * bundler hoists external imports of every module in a chunk, so any static
 * pi import reachable from the root would make every `@byok-sdk/client`
 * consumer load the whole native graph. The thin custody payload module
 * delegates here through the external-dynamic seam instead.
 *
 * The executor runs exactly the one delegated task to completion, printing
 * the JSON event stream to stdout exactly as the vendored foreground lane
 * expects. It is a leaf executor, NOT a second scheduler.
 *
 * The subagents extension is loaded in-process, which is what makes the
 * print→runner and print→print edges reachable AND gated: any subagent spawn
 * this session attempts routes through the same rerouted vendored execution
 * code inside this bundle, and therefore through the same custody dispatcher
 * that minted the record which authorized this process.
 *
 * The ambient process environment IS the dispatcher's attested transport env
 * (the entry validated the record's projection against it before calling
 * here); the run options are read from the record — the vendor argv travels
 * verbatim in the record metadata and is parsed by the shared pi-print-argv
 * authority, never re-derived from flags of this process.
 */
import {
  createAgentSession,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  resolveCliModel,
  runPrintMode,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { DescendantLaunchV1 } from '@byok-sdk/implementation-identity';
import { subagentsExtension } from './pi-extension-factories.js';
import { refusal } from '../custody/custody-commitments';
import { parsePiPrintArgv } from '../custody/pi-print-argv';

/** Options for one delegated print-mode task, projected from the record. */
interface PrintPayloadPlan {
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly sessionDir: string;
  readonly task: string;
  readonly model: string | undefined;
}

function planPrintPayload(launch: DescendantLaunchV1): PrintPayloadPlan {
  const c = launch.perLaunch;
  const rawArgv = c.mcp.metadata['byok.custody.printArgv'];
  const printArgv = Array.isArray(rawArgv) ? rawArgv.filter((entry): entry is string => typeof entry === 'string') : [];
  const parsed = parsePiPrintArgv(printArgv);
  const task = c.task !== '' ? c.task : parsed.task;
  if (task === '') refusal('the dispatched print record carries no delegated task');
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (sessionDir === undefined || sessionDir === '') {
    refusal('PI_CODING_AGENT_SESSION_DIR is absent: the print payload requires the committed session root');
  }
  return {
    cwd: c.session.cwd,
    sessionFile: c.session.file ?? parsed.sessionFile,
    sessionDir,
    task,
    model: parsed.model ?? (c.modelCandidates[0]?.model !== '(session-default)' ? c.modelCandidates[0]?.model : undefined),
  };
}

/**
 * Run the delegated one-shot task in a pi session with the subagents
 * extension, resolving to the print-mode exit code. Everything fail-closed:
 * any service diagnostic error, model resolution failure or session-open
 * refusal propagates to the helper host and exits nonzero without emitting a
 * partial result.
 */
export async function runCustodyPrintPayload(launch: DescendantLaunchV1): Promise<number> {
  const plan = planPrintPayload(launch);
  const agentDir = getAgentDir();
  const sessionManager = plan.sessionFile
    ? SessionManager.open(plan.sessionFile, plan.sessionDir)
    : SessionManager.create(plan.cwd, plan.sessionDir);
  // The subagents extension rides in-process (freeze D2); ambient extension
  // and skill discovery stays off — the child runs exactly what the custody
  // record attests, nothing the filesystem happens to carry.
  const services = await createAgentSessionServices({
    cwd: plan.cwd,
    agentDir,
    modelRuntimeSignal: AbortSignal.timeout(15_000),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, extensionFactories: [subagentsExtension] },
  });
  const errors = [
    ...services.diagnostics.filter((diagnostic) => diagnostic.type === 'error').map((diagnostic) => diagnostic.message),
    ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => `${path}: ${error}`),
  ];
  if (errors.length > 0) refusal(errors.join('\n'));
  const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
    const resolved = plan.model === undefined ? undefined : resolveCliModel({
      cliProvider: undefined, cliModel: plan.model, cliThinking: undefined, modelRuntime: services.modelRuntime,
    });
    if (resolved?.error) refusal(resolved.error);
    const created = await createAgentSession({
      cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent,
      modelRuntime: services.modelRuntime, settingsManager: services.settingsManager, resourceLoader: services.resourceLoader,
      model: resolved?.model,
    });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd: plan.cwd, agentDir, sessionManager });
  return runPrintMode(runtime, { mode: 'json', initialMessage: plan.task });
}
