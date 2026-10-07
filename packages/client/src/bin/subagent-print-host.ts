/**
 * The in-bundle leaf executor for one `pi-subagent-print` child, reached ONLY
 * through the `#byok-pi-runtime-host` seam. This module statically imports the
 * pi session machinery and the vendored subagents extension, and the
 * runtime-host artifact is the one bundle that already carries them. The
 * library root (`dist/index.js`) must stay free of those imports even though
 * it re-exports the helper host, so the helper host reaches this module
 * through the external-dynamic seam.
 *
 * The executor runs exactly the one delegated task to completion and prints
 * the JSON event stream to stdout, as the vendored foreground lane expects. It
 * is a leaf executor, not a second scheduler. The subagents extension loads
 * in-process, so nested spawns go through the same vendored code and its own
 * depth and concurrency limits.
 *
 * The run options come from the vendor's pi-style argv, which arrives as the
 * tail of the helper argv and is read by the shared print-argv parser.
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
import { subagentsExtension } from './pi-extension-factories.js';
import { readFileSync } from 'node:fs';
import { parsePiPrintArgv } from '../subagents/print-argv';

/** Options for one delegated print-mode task, read from the vendor argv. */
interface PrintPayloadPlan {
  readonly cwd: string;
  readonly sessionFile: string | null;
  readonly sessionDir: string | undefined;
  readonly task: string;
  readonly model: string | undefined;
}

function planPrintPayload(argv: readonly string[]): PrintPayloadPlan {
  const parsed = parsePiPrintArgv(argv);
  // The vendor writes the same `Task: …` text into a file when it delivers
  // the task through `@file`.
  const task = parsed.task !== '' ? parsed.task : parsed.taskFile === null ? '' : readFileSync(parsed.taskFile, 'utf8');
  if (task === '') throw new Error('the print child argv carries no delegated task');
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  return {
    cwd: process.cwd(),
    sessionFile: parsed.sessionFile,
    // Unset means Pi's own default session directory.
    sessionDir: sessionDir === undefined || sessionDir === '' ? undefined : sessionDir,
    task,
    model: parsed.model,
  };
}

/**
 * Run the delegated one-shot task in a pi session with the subagents
 * extension, resolving to the print-mode exit code. Everything fail-closed:
 * any service diagnostic error, model resolution failure or session-open
 * refusal propagates to the helper host and exits nonzero without emitting a
 * partial result.
 */
export async function runSubagentPrint(argv: readonly string[]): Promise<number> {
  const plan = planPrintPayload(argv);
  const agentDir = getAgentDir();
  const sessionManager = plan.sessionFile
    ? SessionManager.open(plan.sessionFile, plan.sessionDir)
    : SessionManager.create(plan.cwd, plan.sessionDir);
  // The subagents extension rides in-process. The user's own extensions and
  // skills load beside it, as in the Pi RPC host.
  const services = await createAgentSessionServices({
    cwd: plan.cwd,
    agentDir,
    modelRuntimeSignal: AbortSignal.timeout(15_000),
    resourceLoaderOptions: { extensionFactories: [subagentsExtension] },
  });
  const errors = [
    ...services.diagnostics.filter((diagnostic) => diagnostic.type === 'error').map((diagnostic) => diagnostic.message),
    ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => `${path}: ${error}`),
  ];
  if (errors.length > 0) throw new Error(errors.join('\n'));
  const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
    const resolved = plan.model === undefined ? undefined : resolveCliModel({
      cliProvider: undefined, cliModel: plan.model, cliThinking: undefined, modelRuntime: services.modelRuntime,
    });
    if (resolved?.error) throw new Error(resolved.error);
    const created = await createAgentSession({
      cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent,
      modelRuntime: services.modelRuntime, settingsManager: services.settingsManager, resourceLoader: services.resourceLoader,
      model: resolved?.model,
    });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd: plan.cwd, agentDir, sessionManager });
  return runPrintMode(runtime, { mode: 'json', initialMessage: plan.task });
}
