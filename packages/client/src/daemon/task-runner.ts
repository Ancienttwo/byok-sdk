import { promises as fs, constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
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

type OpenArtifactResult = { ok: true; handle: FileHandle } | { ok: false; reason: string };

/**
 * Finding F7/N5 (artifact path traversal + TOCTOU symlink race): resolve an
 * artifact `name` against `workspaceDir`, then **open it and verify the
 * open file descriptor** — never a path-based check followed by a separate
 * re-open by pathname.
 *
 * The prior version (`resolveArtifactPath`) realpath'd the candidate to
 * verify containment and returned a *path string*; `sendArtifact` then
 * reopened that path via `fs.readFile(path)`. That's a classic
 * check-then-use race: between the realpath check and the later open, the
 * final path component can be swapped for a symlink pointing outside the
 * workspace (a compromised/buggy runtime, or something written by the very
 * agent turn that reported this artifact name), and the reopen would
 * silently follow it. Confirmed pre-fix: swapping the artifact's final
 * component for a symlink to `/etc/hosts` after the containment check
 * passed but before the read caused the daemon to read and upload
 * `/etc/hosts` as the task artifact.
 *
 * Fix: the pathname containment check below is now only a fast,
 * well-messaged early reject (defense in depth — rejects absolute `name`s
 * and `../` traversal before touching the filesystem at all). The actual
 * security boundary is `O_NOFOLLOW` on the `open()` call itself, which
 * fails atomically (`ELOOP`) if the final path component is a symlink —
 * there is no window between "check" and "use" because there is no
 * separate check for symlink-ness, just an open that refuses to follow one
 * — plus an `fstat` on the resulting *file descriptor* (not the path) to
 * confirm it's a regular file. `sendArtifact` reads from that same handle
 * and closes it when done; the bytes it hashes/inlines/uploads are the
 * exact bytes that passed both checks, not a re-read of whatever exists at
 * the path afterward.
 *
 * Residual (documented, not fixed here): `O_NOFOLLOW` only guards the
 * *final* path component (POSIX `open(2)` semantics) — an intermediate
 * directory swapped for a symlink between the realpath below and the
 * `open()` call is not defended against cross-platform; that needs Linux's
 * `openat2`/`RESOLVE_BENEATH`, which Node's stdlib doesn't expose. Out of
 * scope here: that would require an attacker already able to write into the
 * daemon's directory tree above the per-task workspace — a much stronger
 * position than "the runtime reports a crafted artifact name" — whereas the
 * realistic threat this closes (the runtime's own workspace naming a
 * symlinked artifact file) is the one actually reproduced above.
 *
 * M3 TODO (Windows): `fs.constants.O_NOFOLLOW` is `undefined` on Windows,
 * so the `?? 0` below no-ops the flag there (reparse-point/symlink handling
 * for that platform isn't implemented yet) — the realpath+prefix
 * containment check remains the floor of protection on Windows until it
 * is.
 */
async function openArtifact(workspaceDir: string, name: string): Promise<OpenArtifactResult> {
  // Workspace root is daemon-created (see `resolveWorkspaceDir`) and
  // trusted — realpath'd exactly once, not derived from the untrusted
  // `name`, so this step has no TOCTOU exposure of its own.
  const realWorkspaceDir = await fs.realpath(workspaceDir).catch(() => workspaceDir);
  const candidate = path.resolve(realWorkspaceDir, name);

  const prefix = realWorkspaceDir.endsWith(path.sep) ? realWorkspaceDir : realWorkspaceDir + path.sep;
  if (candidate !== realWorkspaceDir && !candidate.startsWith(prefix)) {
    return { ok: false, reason: `artifact name "${name}" resolves outside the task workspace — rejected` };
  }

  const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
  let handle: FileHandle;
  try {
    handle = await fs.open(candidate, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    return { ok: false, reason: `artifact "${name}" could not be opened: ${errorMessage(err)}` };
  }

  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      await handle.close().catch(() => {});
      return { ok: false, reason: `artifact "${name}" is not a regular file` };
    }
  } catch (err) {
    await handle.close().catch(() => {});
    return { ok: false, reason: `artifact "${name}" could not be verified: ${errorMessage(err)}` };
  }

  return { ok: true, handle };
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
  /**
   * Finding F4 (cancel lost during the offer-processing window): a
   * `task.cancel` for a taskId that hasn't finished `handleOffer` yet (still
   * awaiting adapter detection / instruction resolution / workspace setup /
   * `adapter.start()`) has no `this.tasks` entry to land on — it used to be
   * silently dropped, and the runtime session `handleOffer` was about to
   * register would then run an unsupervised ("zombie") turn nobody asked
   * for anymore. Recording the taskId here lets `handleOffer` consult it at
   * the two points where it can still safely react (see its body): before
   * claiming at all (decline instead of ever starting a session), and right
   * after `adapter.start()` resolves but before this task is registered as
   * active (tear the just-started session down immediately, before its
   * event loop ever pumps a single event). Consumed (deleted) at whichever
   * checkpoint handles it; a cancel for a taskId that's already active,
   * already finished, or never offered at all leaves a harmless entry that
   * nothing will ever consult.
   */
  private readonly pendingCancelled = new Map<string, string | undefined>();

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
    // Finding F4, checkpoint 1 ("before claim where possible -> decline
    // path"): a task.cancel already arrived for this exact taskId before
    // this offer was even looked at. Decline outright — never claim, never
    // spawn a runtime session for a task that's already dead. Checked first
    // (ahead of every other pre-claim check below) so a pre-cancelled offer
    // costs nothing beyond this map lookup.
    if (this.pendingCancelled.has(taskId)) {
      const reason = this.pendingCancelled.get(taskId);
      this.pendingCancelled.delete(taskId);
      this.decline(taskId, reason ? `cancelled before claim: ${reason}` : 'cancelled before claim', false);
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

    // Finding F4, checkpoint 2 ("consulted when start() resolves"): a
    // task.cancel arrived while adapter.start() was in flight — i.e. AFTER
    // task.claim already went out above, so declining is no longer an
    // option. Tear the just-started session down before it's ever
    // registered as active (this.tasks.set below) or reported task.started,
    // so pump() never begins and no zombie turn runs — then report the
    // outcome exactly like a post-registration cancel would (M1 gap #6:
    // task.cancelled, not task.fail).
    if (this.pendingCancelled.has(taskId)) {
      const reason = this.pendingCancelled.get(taskId);
      this.pendingCancelled.delete(taskId);
      try {
        await session.interrupt();
      } catch {
        // best-effort — still report cancellation below
      }
      try {
        await session.close();
      } catch {
        // best-effort teardown
      }
      this.deps.send(createEnvelope('task.cancelled', { reason }, { taskId }));
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
   *
   * Finding F7/N5: `name` is untrusted (it's whatever the runtime/agent
   * reported — ultimately model-influenced) and used to be `path.join`'d
   * onto `workspaceDir` with no check that the result stayed inside it, so
   * `../../<anything>` (or an absolute `name`, which `path.resolve` accepts
   * verbatim as the whole path) could read and exfiltrate an arbitrary file
   * on the host as a task artifact. A later fix (`resolveArtifactPath`)
   * closed the traversal case by realpath-checking containment, but still
   * returned a path string that was reopened by pathname afterward — a
   * check-then-use TOCTOU race letting the final component be swapped for
   * an out-of-workspace symlink between the check and the read.
   * `openArtifact` now opens the file (with `O_NOFOLLOW`) and verifies the
   * resulting file descriptor directly; this reads from that same handle,
   * never re-opening by pathname. Read/upload failures (including a
   * rejected name or a blocked symlink swap) are also not silent: they
   * surface as a loud `error` `AgentEvent` batched into `task.progress`,
   * and are logged — the task itself can still reach `task.complete`
   * normally, but the dropped artifact is now visible in the event stream
   * rather than swallowed.
   */
  private async sendArtifact(active: ActiveTask, name: string, contentType: string): Promise<void> {
    const opened = await openArtifact(active.workspaceDir, name);
    if (!opened.ok) {
      this.reportArtifactError(active, name, opened.reason);
      return;
    }

    let bytes: Buffer;
    try {
      bytes = await opened.handle.readFile();
    } catch (err) {
      this.reportArtifactError(active, name, `failed to read artifact "${name}": ${errorMessage(err)}`);
      return;
    } finally {
      await opened.handle.close().catch(() => {});
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
    } catch (err) {
      this.reportArtifactError(active, name, `failed to upload artifact "${name}": ${errorMessage(err)}`);
    }
  }

  /** Loud, non-silent artifact failure (finding F7): logged, and folded into this task's own progress stream as an `error` AgentEvent rather than swallowed — the task itself can still complete normally, but the omission is now visible. */
  private reportArtifactError(active: ActiveTask, name: string, reason: string): void {
    console.error(`[byok/client] artifact "${name}" for task ${active.taskId} dropped: ${reason}`);
    active.batcher.push({ type: 'error', message: reason });
  }

  private async handleCancel(taskId: string, reason: string | undefined): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) {
      // Finding F4: not registered yet — record it in case handleOffer is
      // still in flight for this exact taskId (claimed but not yet started;
      // see the class-level doc on `pendingCancelled` and the two
      // checkpoints in handleOffer). A genuinely stale/unknown/already-
      // finished taskId just leaves a harmless, never-consulted entry —
      // identical in effect to the old silent-drop behavior for that case.
      this.pendingCancelled.set(taskId, reason);
      return;
    }
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
