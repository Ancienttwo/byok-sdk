// BYOK change: Modified from OAR c88a514 for injected processes, an explicit environment, a record consumer and session credential redaction without sealSession (Apache-2.0).
/* oxlint-disable import/max-dependencies -- Session assembly wires the environment, process, terminal host, recorder and control machinery. */
/* oxlint-disable typescript/promise-function-async -- SDK callbacks deliberately return the SDK's native promises. */
import type { AvailableInstallation } from "../../contracts/installation.js";
import type {
  AdapterSession,
  ControlResult,
  InputOptions,
  RawEvent,
  RequestBody,
  RequestRecord,
  ResponseBody,
  SessionOptions,
} from "../../contracts/session.js";
// BYOK change: Build the session credential redactor directly; upstream withSessionCredentials imports sealSession.
import { sessionCredentialRedactor, type CredentialRedactor } from "../credential-redactor.js";
import { createSessionKernel } from "../session-kernel.js";
import { createAcpClientApp } from "./client-app.js";
import {
  acpMcpOpenGuard,
  closeAcpSession,
  createUsageUpdateGate,
  openAcpSession,
  type AcpSessionProfile,
} from "./profile.js";
import { acpLaunchArgs } from "./launch-args.js";
import { startAcpProcess, type SpawnAcpLineProcess } from "./process.js";
import { createAcpRecorder } from "./records.js";
import { createAcpTerminalHost, type SpawnAcpTerminal } from "./terminal.js";
import { acpTakesImages, createAcpTurns } from "./turns.js";
import { createAcpTokenUsage } from "./token-usage.js";
import { createAcpOpening } from "./opening.js";

export type { AcpSessionProfile } from "./profile.js";

/*
 * ACP mapping onto the record stream (shared by grok and kimi; profiles carry the vendor bits):
 * - every `session/update` is ONE event record, native verbatim, for WHATEVER
 *   session id it names: a foreign id is a derived child session (records.ts).
 * - listed vendor notifications are recorded verbatim except credential redaction.
 * - runtime→app requests (permission, terminal) are toApp request records;
 *   oar's automatic answer is the matching `answered` response (client-app.ts).
 * - prompt / steer / queue / withdraw / abort / dispose are toRuntime requests answered
 *   accepted-or-rejected; the turn's end is the runtime's own prompt answer
 *   (turns.ts) or the process exit oar observed (`exited` response).
 */

// BYOK change: the caller passes the complete filtered environment, so a value is never a null removal.
export type AcpSessionOptions = Omit<SessionOptions, "env"> & { readonly env: Readonly<Record<string, string>> };

// BYOK change: the record consumer is registered before any record is appended.
export interface AcpSessionHooks {
  /** The native session id, before any record is delivered; a throw fails the open. */
  readonly onReady?: (sessionId: string) => void;
  /** A kernel observer from seq 0. The kernel swallows its errors, so it fails the session itself. */
  readonly onRecord?: (record: RawEvent) => void;
}

// BYOK change: the caller owns the agent process, every hosted terminal process and the environment.
export type StartAcpSession = (
  spawnLineProcess: SpawnAcpLineProcess,
  spawnTerminal: SpawnAcpTerminal,
  installation: AvailableInstallation,
  options: AcpSessionOptions,
  hooks?: AcpSessionHooks,
) => Promise<AdapterSession>;

export function acpSession(profile: AcpSessionProfile): StartAcpSession {
  // BYOK change: Upstream withSessionCredentials without sealSession. One redactor per open keeps
  // opening failures, retained records and later control errors under the same credential rules.
  return async (spawnLineProcess, spawnTerminal, installation, options, hooks = {}) => {
    const credentials = sessionCredentialRedactor(options);
    try { return await openAcpRuntimeSession(profile, spawnLineProcess, spawnTerminal, installation, options, hooks, credentials); }
    catch (error) { throw credentials.redactValue(error); }
  };
}

async function openAcpRuntimeSession(
  profile: AcpSessionProfile,
  spawnLineProcess: SpawnAcpLineProcess,
  spawnTerminal: SpawnAcpTerminal,
  installation: AvailableInstallation,
  options: AcpSessionOptions,
  hooks: AcpSessionHooks,
  credentials: CredentialRedactor,
): Promise<AdapterSession> {
    if (installation.via !== "executable") {
      throw new Error("ACP runtimes require an executable installation");
    }
    profile.validateOptions?.(options);
    // SessionOptions.mcpServers go out in the open request (mcp-servers.ts):
    // a list with an empty or repeated name fails before anything starts,
    // and an open that fails reports no credential they carry.
    const withoutCredentials = acpMcpOpenGuard(options.mcpServers, credentials.redact);
    const args = acpLaunchArgs(profile, options);
    // BYOK change: explicit environment; nothing ambient is merged.
    if (options.env === undefined) throw new Error("ACP session requires an explicit filtered environment");
    const environment = options.env;
    const terminalHost = createAcpTerminalHost(spawnTerminal, options.cwd, environment, {
      shellCommand: profile.terminalShellCommand === true,
    });
    // The recorder queues everything until the handshake reveals the session
    // id and the kernel can be bound (records.ts).
    const usageGate = createUsageUpdateGate();
    const tokenUsage = createAcpTokenUsage(profile);
    const opening = createAcpOpening();
    const recorder = createAcpRecorder(usageGate, profile.attributeUpdate, tokenUsage);
    const client = createAcpClientApp(terminalHost, {
      update: (notification) => {
        recorder.update(notification);
      },
      extension: (method, params) => {
        recorder.extension(method, profile.redactExtensionNotification?.(method, params) ?? params, opening.afterOpen(params));
      },
      requested: (id, method, params) => {
        recorder.requested(id, method, params);
      },
      answered: (id, reply) => {
        recorder.answered(id, reply);
      },
      extensionNotifications: profile.extensionNotifications ?? [],
    });
    const runtime = startAcpProcess(spawnLineProcess, installation.command, args, client, { cwd: options.cwd, env: environment, redact: credentials.redact, opening });
    const release = async (): Promise<void> => {
      runtime.kill();
      await runtime.exited;
      await terminalHost.dispose();
    };
    const opened = await openAcpSession(runtime, profile, options, (step) => {
      recorder.step(step.method, step.response);
    }).catch(async (error: unknown) => {
      await release();
      throw withoutCredentials(error);
    });
    // BYOK change: the record consumer observes from seq 0: it registers before the recorder binds.
    const kernel = createSessionKernel(opened.sessionId, credentials.redactValue);
    if (hooks.onRecord !== undefined) kernel.rawEvents(hooks.onRecord);
    try {
      hooks.onReady?.(opened.sessionId);
    } catch (error) {
      await release();
      throw error;
    }
    recorder.bind(kernel);

    let disposeRequest: RequestRecord | null = null;
    const capabilities = { ...profile.capabilities, images: profile.capabilities.images ?? acpTakesImages(opened.initialized) };
    const turns = createAcpTurns({ kernel, runtime, profile, usageGate, capabilities, promptMeta: profile.promptMeta?.(options), promptUsage: (result) => tokenUsage.prompt(result) });
    // oxlint-disable-next-line promise/prefer-await-to-then, promise/always-return -- Exit observation outlives session creation.
    void runtime.exited.then((code) => {
      // BYOK change: the session's dispose awaits and reports this same disposal.
      void terminalHost.dispose().catch(() => {});
      // An outcome only oar observes: answers our dispose when we caused the
      // exit, stands alone (requestId "") when the runtime died on its own.
      kernel.respond(disposeRequest?.id ?? "", { kind: "exited", code });
      turns.onExit();
    });

    // Reachability (exited, disposed) is the kernel's gate, read off the
    // stream; the adapter decides only the runtime-specific answers (busy,
    // not_steerable). `runtime.closed` flips synchronously on the process's
    // exit, one microtask before the observer above records the `exited`
    // response: a control landing in that window would otherwise be decided
    // here (rejected "ACP process exited") instead of by the gate, so the
    // exit is let land first.
    const control = async (
      body: RequestBody,
      decide: (request: RequestRecord) => ResponseBody | Promise<ResponseBody>,
    ): Promise<ControlResult> => {
      if (runtime.closed && kernel.unreachable() === null) {
        await runtime.exited;
      }
      return kernel.control(body, decide);
    };

    // A profile without steer params cannot inject, so the session has no `steer`.
    const { steerParams } = profile;
    const steer = steerParams === undefined
      ? {}
      : {
        steer: (input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "steer", input, ...inputOptions }, (): ResponseBody | Promise<ResponseBody> => {
          const state = turns.active();
          return state === null
            ? { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" }
            : turns.steer(state, input, inputOptions, steerParams(input));
        }),
      };

    // BYOK change: The upstream credentials.seal guard without sealSession: a control's thrown error is redacted.
    const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>) =>
      async (...args: Args): Promise<Result> => {
        try { return await method(...args); } catch (error) { throw credentials.redactValue(error); }
      };
    return { // BYOK change: raw adapter without sealSession/observe dependencies.
      id: kernel.sessionId,
      capabilities,
      prompt: guard((input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "prompt", input, ...inputOptions }, (request): ResponseBody =>
        (turns.active() === null ? turns.begin(request, input, inputOptions?.images) : { kind: "rejected", code: "busy", reason: "busy" }))),
      ...(steer.steer === undefined ? {} : { steer: guard(steer.steer) }),
      queue: guard((input: string, inputOptions?: InputOptions): Promise<ControlResult> => control({ kind: "queue", input, ...inputOptions }, () => turns.hold(input, inputOptions?.images, inputOptions?.inputId))),
      // The queue is held here (turns.ts), not by the vendor: an entry can be taken back until the drain sends it.
      withdraw: guard((inputId: string): Promise<ControlResult> => control({ kind: "withdraw", inputId }, () => turns.withdraw(inputId))),
      abort: guard((): Promise<ControlResult> => control({ kind: "abort" }, (): ResponseBody | Promise<ResponseBody> => {
        const state = turns.active();
        return state === null ? { kind: "rejected", code: "no_active_turn", reason: "no active turn" } : turns.abort(state);
      })),
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      // BYOK change: no `resources` reader; the SDK process-tree authority owns the tree.
      dispose: guard(async () => {
        if (disposeRequest !== null) {
          // Already released: the stream holds our dispose request. BYOK change:
          // a retry after a failed terminal reap reaps what is still alive.
          await terminalHost.dispose();
          return;
        }
        // Read BEFORE this dispose is recorded: only an observed exit can say
        // so here, and it is the stream's word, not an adapter flag.
        const gone = kernel.unreachable() !== null;
        disposeRequest = kernel.request("toRuntime", { kind: "dispose" });
        if (gone) {
          // The exit is already recorded (an unrequested `exited` response, requestId "");
          // nothing is left to release, so the dispose is answered here, as
          // the claude and codex adapters do (kimi 0.42.0 kill-runtime run,
          // 2026-09-11: the dispose request stood unanswered before this).
          kernel.respond(disposeRequest.id, { kind: "accepted" });
          await terminalHost.dispose();
          return;
        }
        const state = turns.active();
        if (state !== null && !runtime.closed) {
          await turns.abort(state);
        }
        if (opened.supportsClose && !runtime.closed) {
          await closeAcpSession(runtime, kernel.sessionId).catch(() => {});
        }
        runtime.kill();
        await runtime.exited;
        await terminalHost.dispose();
      }),
    };
}
