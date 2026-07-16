import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createEnvelope,
  type BlobRef,
  type Envelope,
  type PermissionPolicy,
  type TaskOfferPayload,
} from '@byok/protocol';
import { PolicyUnsupportedError, type RuntimeAdapter, type Session, type TaskContext } from '../types';
import type { BlobResolver } from './blob-client';
import { computeEffectivePolicy } from './policy';
import { ProgressBatcher, type ProgressBatcherOptions } from './progress-batcher';
import type { SessionWorkspaceStore } from './session-workspace-store';

/** Inline artifact payloads must stay under this many UTF-8 bytes — mirrors the frozen `TaskArtifactPayloadSchema.inline` limit in `packages/protocol` (see docs/protocol.md §7). Anything bigger goes through the blob client. */
const MAX_INLINE_ARTIFACT_BYTES = 64 * 1024;

export interface TaskRunnerDeps {
  adapters: RuntimeAdapter[];
  runtimeAllowlist?: string[];
  permissionDefaults?: PermissionPolicy;
  workspaceRoot: string;
  deviceId: string;
  send: (envelope: Envelope) => void;
  blobClient: BlobResolver;
  /**
   * True while the connection has fallen back to long-poll (protocol §8):
   * there is no daemon->server HTTP path in that mode, so new offers are
   * declined immediately (`retryable: true`) rather than claimed — there is
   * no way to make progress on them until WS recovers. See the M1-3
   * contract-gap note in the task report.
   */
  isTransportDegraded: () => boolean;
  batcherOptions?: ProgressBatcherOptions;
  /**
   * Finding #3 (session/workspace continuity): persists `sessionRef ->
   * workspaceDir` across daemon restarts so a `task.offer` naming a
   * previously-reported `sessionRef` reuses that exact workspace instead of
   * a fresh `workspaceRoot/<taskId>` — see `handleOffer` and
   * `SessionWorkspaceStore`'s own doc comment.
   */
  sessionWorkspaces: SessionWorkspaceStore;
}

interface ActiveTask {
  taskId: string;
  adapter: RuntimeAdapter;
  session: Session;
  workspaceDir: string;
  batcher: ProgressBatcher;
  summaryParts: string[];
}

type PickResult =
  | { ok: true; adapter: RuntimeAdapter }
  | { ok: false; reason: string; retryable: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-connection task orchestration: offer -> (decline | claim -> adapter
 * session -> started) -> seq-ordered progress batches -> complete/fail/
 * cancelled, plus approve/reject/cancel/steer handling.
 *
 * M1 rework (docs/protocol.md §3, §5, §10 — `packages/protocol` is frozen,
 * not editable here): pre-claim rejections (unknown/disallowed runtime,
 * policy exceeding this device's ceiling) now send `task.decline` and never
 * claim at all — `TASK_TRANSITIONS.Offered` gained a direct `-> Failed` edge
 * precisely so this no longer has to claim-then-fail. A successful claim is
 * followed by `task.started` only once the adapter session has actually
 * started (`task.claim` alone no longer implies `Running`). Cancellation
 * reports the explicit `task.cancelled` message instead of the old
 * `task.fail({reason:'cancelled'})` convention.
 */
export class TaskRunner {
  private readonly tasks = new Map<string, ActiveTask>();

  constructor(private readonly deps: TaskRunnerDeps) {}

  get activeTaskCount(): number {
    return this.tasks.size;
  }

  async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.type) {
      case 'task.offer':
        await this.handleOffer(envelope.task_id, envelope.payload);
        return;
      case 'task.cancel':
        await this.handleCancel(envelope.task_id, envelope.payload.reason);
        return;
      case 'task.steer':
        await this.handleSteer(envelope.task_id, envelope.payload.text);
        return;
      case 'task.approve':
        await this.handleApprove(envelope.task_id);
        return;
      case 'task.reject':
        await this.handleReject(envelope.task_id, envelope.payload.reason);
        return;
      default:
        return; // conn.* and daemon->server-only types are handled elsewhere / not applicable
    }
  }

  private async handleOffer(taskId: string, payload: TaskOfferPayload): Promise<void> {
    if (this.deps.isTransportDegraded()) {
      // Protocol §8: long-poll fallback has no daemon->server HTTP path, so
      // even this decline just queues on the (currently down) WS transport
      // until it recovers — see the connection manager's outbox and the
      // M1-3 contract-gap note in the task report.
      this.decline(taskId, 'no live WS connection to run tasks on (transport-degraded)', true);
      return;
    }

    const pick = await this.pickAdapter(payload.runtime);
    if (!pick.ok) {
      this.decline(taskId, pick.reason, pick.retryable);
      return;
    }

    const decision = computeEffectivePolicy(payload.policy, this.deps.permissionDefaults);
    if (!decision.ok) {
      this.decline(taskId, decision.reason ?? 'policy rejected', false);
      return;
    }

    // Every check above is local/config-driven (an adapter's `detect()` is
    // the only I/O, and it costs nothing to have run before committing) and
    // needed no commitment from this device. Only now do we actually take
    // the task — `task.decline` above is the alternative path for anything
    // that got this far without claiming.
    this.deps.send(createEnvelope('task.claim', { deviceId: this.deps.deviceId }, { taskId }));

    let resolvedInstruction: string;
    try {
      resolvedInstruction = await this.resolveInstruction(payload.instruction);
    } catch (err) {
      await this.fail(taskId, `failed to resolve instruction blob: ${errorMessage(err)}`, true);
      return;
    }

    // Finding #3 (session/workspace continuity): an offer naming a
    // sessionRef this device has previously recorded (via a prior task's
    // `task.complete.sessionRef`) reuses that exact workspace directory —
    // this is what lets a runtime adapter's own resume mechanism (e.g. pi's
    // `--session <id>`, scoped to the cwd/project a session was created
    // under — see pi-adapter.ts) actually find the session again. An
    // unknown or absent sessionRef is always treated as "start fresh",
    // exactly as before this feature existed.
    const known = payload.sessionRef ? await this.deps.sessionWorkspaces.get(payload.sessionRef) : undefined;

    let workspaceDir: string;
    try {
      workspaceDir = await this.resolveWorkspaceDir(taskId, known?.workspaceDir);
    } catch (err) {
      await this.fail(taskId, `failed to create task workspace: ${errorMessage(err)}`, true);
      return;
    }

    const ctx: TaskContext = { workspaceDir, policy: decision.policy, env: process.env };
    const effectiveOffer: TaskOfferPayload = {
      ...payload,
      instruction: resolvedInstruction,
      // Never forward a sessionRef this device has no recorded workspace
      // for (stale, from another device, or simply made up) — an adapter
      // that tries to resume an id it never minted fails outright (pi:
      // "No session found matching '<id>'", exit 1, empirically confirmed)
      // instead of silently starting fresh, so an unresolvable sessionRef
      // must look identical to "none supplied" by the time it reaches the
      // adapter, not get forwarded as a resume attempt doomed to fail.
      sessionRef: known ? payload.sessionRef : undefined,
    };

    let session: Session;
    try {
      session = await pick.adapter.start(effectiveOffer, ctx);
    } catch (err) {
      // A PolicyUnsupportedError means this exact task can never succeed on
      // this adapter (fail-closed policy/instruction mismatch) — not
      // retryable. Anything else (spawn failure, missing credentials, etc)
      // is treated as environmental and possibly transient.
      const retryable = !(err instanceof PolicyUnsupportedError);
      await this.fail(taskId, `adapter failed to start: ${errorMessage(err)}`, retryable);
      return;
    }

    // Claimed -> Running (M1 gap #2): report `task.started` only once the
    // adapter session has actually started — never implied by `task.claim`.
    this.deps.send(createEnvelope('task.started', {}, { taskId }));

    // This handoff (construct `active` -> register it -> kick off `pump()`)
    // must stay synchronous, with no `await` in between: a `task.cancel`
    // (or `task.steer`/`task.approve`/`task.reject`) for this exact taskId
    // can arrive and be processed by `handleEnvelope` at any `await` point,
    // and every one of those handlers starts with `this.tasks.get(taskId)`
    // — if this task isn't registered yet, they silently no-op (see e.g.
    // `handleCancel`). An earlier version of this method awaited the
    // sessionWorkspaces write (below) before registering `active` and broke
    // exactly this: a cancel racing a task.offer lost its `interrupt()`/
    // `task.cancelled` entirely.
    const active: ActiveTask = {
      taskId,
      adapter: pick.adapter,
      session,
      workspaceDir,
      summaryParts: [],
      batcher: new ProgressBatcher(
        (seq, events) => this.deps.send(createEnvelope('task.progress', { seq, events }, { taskId, seq })),
        this.deps.batcherOptions,
      ),
    };
    this.tasks.set(taskId, active);
    void this.pump(active);

    // Record (or refresh) this session's resumable workspace for any future
    // task.offer that carries the same sessionRef, fire-and-forget:
    // `session.sessionRef` is always the adapter's real, resumable
    // identifier (see PiSession / resolveFreshSessionId) whether or not
    // *this* dispatch was itself a resume. Deliberately not awaited — see
    // the comment above; losing this mapping only costs a future resume
    // opportunity, never the correctness of the task in progress.
    void this.deps.sessionWorkspaces
      .record(session.sessionRef, { workspaceDir, runtimeSessionId: session.sessionRef })
      .catch(() => {});
  }

  /** Protocol §7: an instruction too large to inline arrives as a `blobRef` — resolve it via the blob client rather than failing closed. */
  private async resolveInstruction(instruction: TaskOfferPayload['instruction']): Promise<string> {
    if (typeof instruction === 'string') return instruction;
    return this.deps.blobClient.resolveInstruction(instruction.blobRef);
  }

  private async pump(active: ActiveTask): Promise<void> {
    try {
      for await (const event of active.session.events) {
        // A concurrent task.cancel/task.reject may already have finished
        // (and deleted) this task while this loop was awaiting the next
        // event — e.g. the runtime's own interrupt handling settles with a
        // trailing turn_end shortly after handleCancel() already reported
        // task.cancelled and started tearing the session down. That event
        // is stray at this point: without this check, the turn_end branch
        // below would unconditionally resend task.complete (and any
        // buffered task.progress) for a task the server already moved to a
        // terminal state, which it can only log as a dropped/illegal
        // transition (console.warn) rather than the silent-drop §9
        // guarantees for genuinely stale terminal messages. Mirrors the
        // same check already used below for the non-turn_end loop exits.
        if (this.tasks.get(active.taskId) !== active) return;

        if (event.type === 'needs_approval') {
          active.batcher.flush();
          this.deps.send(
            createEnvelope('task.await_approval', { summary: event.summary }, { taskId: active.taskId }),
          );
          continue;
        }
        if (event.type === 'turn_end') {
          active.batcher.push(event);
          active.batcher.flush();
          this.deps.send(
            createEnvelope(
              'task.complete',
              { summary: active.summaryParts.join(''), sessionRef: active.session.sessionRef },
              { taskId: active.taskId, sessionRef: active.session.sessionRef },
            ),
          );
          await this.finish(active.taskId);
          return;
        }
        if (event.type === 'progress') {
          active.summaryParts.push(event.text);
        }
        if (event.type === 'artifact') {
          await this.sendArtifact(active, event.name, event.contentType);
        }
        active.batcher.push(event);
      }
      // The events iterable ended without an explicit turn_end. This is
      // usually the underlying runtime process exiting unexpectedly — but
      // it's also exactly what happens when `handleCancel`/`handleReject`
      // concurrently call `session.close()` while this loop is still
      // awaiting the same iterable (ending it is how those paths stop the
      // session). Check identity against the tasks map — if something else
      // already finished this exact active task, its own message
      // (task.cancelled / task.fail) already reported the outcome; this is
      // not a second failure.
      if (this.tasks.get(active.taskId) !== active) return;
      await this.fail(active.taskId, 'runtime session ended without completing the task', true);
    } catch (err) {
      if (this.tasks.get(active.taskId) !== active) return;
      active.batcher.flush();
      await this.fail(active.taskId, `runtime error: ${errorMessage(err)}`, true);
    }
  }

  /**
   * Protocol §7: an `artifact` `AgentEvent` only names a file the runtime
   * wrote into the task workspace (`name`/`contentType` — it carries no
   * content of its own); this reads it from disk and sends the actual
   * `task.artifact` wire message — inline (base64) under 64KB, or via blob
   * upload above that, with a sha-256 `contentHash`.
   */
  private async sendArtifact(active: ActiveTask, name: string, contentType: string): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path.join(active.workspaceDir, name));
    } catch {
      return; // the runtime reported an artifact it never actually wrote — nothing to send
    }

    if (bytes.length <= MAX_INLINE_ARTIFACT_BYTES) {
      const inline = bytes.toString('base64');
      if (new TextEncoder().encode(inline).length <= MAX_INLINE_ARTIFACT_BYTES) {
        this.deps.send(createEnvelope('task.artifact', { name, contentType, inline }, { taskId: active.taskId }));
        return;
      }
    }

    try {
      const blobRef: BlobRef = await this.deps.blobClient.uploadArtifact(bytes, contentType);
      this.deps.send(createEnvelope('task.artifact', { name, contentType, blobRef }, { taskId: active.taskId }));
    } catch {
      // Best-effort: a failed artifact upload doesn't fail the whole task —
      // the task's own completion/failure is reported independently by pump().
    }
  }

  private async handleCancel(taskId: string, reason: string | undefined): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return; // unknown or already-finished task
    try {
      await active.session.interrupt();
    } catch {
      // best-effort — still report cancellation below
    }
    // Deliberately NOT active.batcher.flush()-ed here (M1-4 e2e finding):
    // §4's "server state is authoritative on its own action" rule means the
    // server already moved this task to `Cancelled` — and already closed
    // this task's ServerTaskEvent queue (hub.ts's onStateChange, called
    // synchronously from cancelTask() before task.cancel is even sent) —
    // before this notification reaches the daemon at all. Any progress
    // still buffered in the batcher at this point can therefore never reach
    // an embedder no matter what: sending it only draws a
    // dropped/illegal-transition warning on the server for a `task.progress`
    // arriving against an already-terminal task (hub.ts's onProgress has no
    // §9 stale-terminal-message idempotency for task.progress the way it
    // does for task.complete/fail/cancelled). `finish()` below already stops
    // the batcher; nothing else needs to happen with its buffer contents.
    // M1 gap #6: the canonical, explicit cancellation message — no longer
    // `task.fail({reason:'cancelled'})`.
    this.deps.send(createEnvelope('task.cancelled', { reason }, { taskId }));
    await this.finish(taskId);
  }

  private async handleSteer(taskId: string, text: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    await active.session.steer(text);
  }

  /**
   * Protocol §5 approval flow: the server's own state already moved
   * `AwaitApproval -> Running` before this best-effort notification arrives
   * (§4) — resuming the session is what makes `task.progress` continue.
   */
  private async handleApprove(taskId: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    try {
      await active.session.resolveApproval(true);
    } catch (err) {
      await this.fail(taskId, `failed to resume session after approval: ${errorMessage(err)}`, false);
    }
  }

  /**
   * Protocol §5 approval flow: the server's own state already moved
   * `AwaitApproval -> Failed` before this best-effort notification arrives
   * (§4) — the daemon's job is just to stop the session and prove it via
   * `task.fail`.
   */
  private async handleReject(taskId: string, reason: string | undefined): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    try {
      await active.session.resolveApproval(false, reason);
    } catch {
      // best-effort — still report the rejection outcome below
    }
    try {
      await active.session.interrupt();
    } catch {
      // best-effort
    }
    // Same reasoning as handleCancel() above: the server already moved this
    // task to `Failed` and closed its event queue before this notification
    // arrived, so flushing buffered progress here would be unobservable and
    // only trigger a spurious server-side warning.
    this.deps.send(createEnvelope('task.fail', { reason: reason ?? 'rejected', retryable: false }, { taskId }));
    await this.finish(taskId);
  }

  /** Pre-claim, fail-closed rejection (protocol §3.2) — never claims first. */
  private decline(taskId: string, reason: string, retryable: boolean): void {
    this.deps.send(createEnvelope('task.decline', { reason, retryable }, { taskId }));
  }

  private async fail(taskId: string, reason: string, retryable: boolean): Promise<void> {
    this.deps.send(createEnvelope('task.fail', { reason, retryable }, { taskId }));
    await this.finish(taskId);
  }

  private async finish(taskId: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    active.batcher.stop();
    this.tasks.delete(taskId);
    try {
      await active.session.close();
    } catch {
      // best-effort teardown
    }
  }

  /** `reuseDir`, when set (a known sessionRef's recorded workspace), is used verbatim instead of a fresh `workspaceRoot/<taskId>` directory — `mkdir recursive` is idempotent either way, so ensuring-exists is safe to do unconditionally. */
  private async resolveWorkspaceDir(taskId: string, reuseDir: string | undefined): Promise<string> {
    const dir = reuseDir ?? path.join(this.deps.workspaceRoot, taskId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async pickAdapter(requestedRuntime: string | undefined): Promise<PickResult> {
    const allowlist = this.deps.runtimeAllowlist;

    if (requestedRuntime) {
      if (allowlist && !allowlist.includes(requestedRuntime)) {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" is not in this device's runtime allowlist`,
          retryable: false,
        };
      }
      const adapter = this.deps.adapters.find((a) => a.id === requestedRuntime);
      if (!adapter) {
        return { ok: false, reason: `unknown runtime "${requestedRuntime}"`, retryable: false };
      }
      const detected = await adapter.detect();
      if (!detected.present) {
        return {
          ok: false,
          reason: `runtime "${requestedRuntime}" is not installed/available on this device`,
          retryable: true,
        };
      }
      return { ok: true, adapter };
    }

    const candidates = allowlist
      ? this.deps.adapters.filter((a) => allowlist.includes(a.id))
      : this.deps.adapters;
    for (const adapter of candidates) {
      const detected = await adapter.detect();
      if (detected.present) return { ok: true, adapter };
    }
    return { ok: false, reason: 'no available runtime found on this device', retryable: true };
  }
}
