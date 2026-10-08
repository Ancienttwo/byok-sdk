// BYOK change: Modified from OAR 98be973 to bound control RPCs and record timeout rejection (Apache-2.0).
import { emptyInputRefusal } from "../../shared/control-input.js";
import type {
  ControlResult,
  RequestBody,
  RequestRecord,
  ResponseBody,
  ResponseRecord,
} from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import { RpcTimeoutError, type AppServerClient } from "./app-server-client.js";

export interface RpcControlPlan {
  readonly body: RequestBody;
  /** Runtime-specific refusal before sending (busy, nothing active); null means proceed. May reserve adapter state. Reachability is not its job. */
  readonly gate: (request: RequestRecord) => ResponseBody | null;
  readonly method: string;
  readonly timeoutMs?: number; // BYOK change: per-control deadline, default 30s.
  readonly params: () => JsonRecord;
  readonly onReply: (reply: JsonRecord) => ResponseBody;
  readonly onError: (message: string) => ResponseBody;
  /** Arm a turn fallback that can take over and accept before the RPC settles. */
  readonly onPending?: (accept: () => void) => void;
}

/**
 * A control action backed by one app-server RPC: record the request; when the
 * stream already says the runtime is unreachable (`kernel.unreachable()`:
 * exited or disposed), or input is empty with no images, record that
 * rejection without running the plan; if the
 * plan's gate refuses, record that; otherwise send and record the reply AS
 * the reply line is read (synchronously, through the client's onSettled hook)
 * so the response sits in the stream before any notification codex wrote
 * after it; a promise continuation would land after notifications from the
 * same chunk.
 */
export async function rpcControl(
  kernel: SessionKernel,
  client: AppServerClient,
  plan: RpcControlPlan,
): Promise<ControlResult> {
  const blocked = kernel.unreachable();
  const request = kernel.request("toRuntime", plan.body);
  const refused = blocked ?? emptyInputRefusal(plan.body) ?? plan.gate(request);
  if (refused !== null) {
    return { request, response: kernel.respond(request.id, refused) };
  }
  // BYOK change: The client promise already owns waiting; record failure propagates without a stranded second promise.
  let response: ResponseRecord | undefined;
  const record = (decided: ResponseBody): void => {
    if (response === undefined) response = kernel.respond(request.id, decided);
  };
  // BYOK change: Timeout is always a rejected control response, independent of runtime error mapping.
  const onError = (error: unknown): ResponseBody => error instanceof RpcTimeoutError
    ? { kind: "rejected", code: "error", reason: error.message }
    : plan.onError(error instanceof Error ? error.message : String(error));
  // BYOK change: The takeover runs in the fallback timer. A failed record rejects this control and never escapes the timer.
  let takeoverFailure: unknown;
  plan.onPending?.(() => {
    try { record({ kind: "accepted" }); } catch (error) { takeoverFailure ??= error; }
  });
  // A fallback answers independently of transport settlement. Keep observing
  // the RPC: a late native reply remains a frame, never a second response.
  try {
    await client.request(plan.method, plan.params(), (outcome) => {
      if (response !== undefined) {
        const native = outcome.kind === "result" ? outcome.result : (outcome.kind === "error" ? outcome.native : undefined);
        if (native !== undefined) { kernel.frame({ type: plan.method, native, events: [] }); }
      } else if (outcome.kind === "exited") {
        record({ kind: "rejected", code: "runtime_exited", reason: outcome.error.message });
      } else {
        record(outcome.kind === "result" ? plan.onReply(outcome.result) : onError(outcome.error));
      }
    }, plan.timeoutMs ?? 30_000); // BYOK change: no indefinitely suspended control.
  } catch (error) {
    if (response === undefined) { record(onError(error)); }
  }
  if (response === undefined) throw takeoverFailure ?? new Error("app-server control settled without a response record"); // BYOK change
  return { request, response };
}

/**
 * The open RPC, with its failure named after the method (a refused resume
 * must say `thread/resume`: "no rollout found for thread id …" alone does
 * not) and the app-server that was started for it killed.
 */
export async function openThread(
  client: AppServerClient,
  method: "thread/start" | "thread/resume",
  send: () => Promise<JsonRecord>,
): Promise<JsonRecord> {
  try {
    return await send();
  } catch (error) {
    client.kill();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`codex ${method} failed: ${message}`, { cause: error });
  }
}
