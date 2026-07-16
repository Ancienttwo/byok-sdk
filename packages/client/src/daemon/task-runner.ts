import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createEnvelope,
  type Envelope,
  type PermissionPolicy,
  type TaskOfferPayload,
} from '@byok/protocol';
import { PolicyUnsupportedError, type RuntimeAdapter, type Session, type TaskContext } from '../types';
import { computeEffectivePolicy } from './policy';
import { ProgressBatcher, type ProgressBatcherOptions } from './progress-batcher';

export interface TaskRunnerDeps {
  adapters: RuntimeAdapter[];
  runtimeAllowlist?: string[];
  permissionDefaults?: PermissionPolicy;
  workspaceRoot: string;
  deviceId: string;
  send: (envelope: Envelope) => void;
  batcherOptions?: ProgressBatcherOptions;
}

interface ActiveTask {
  taskId: string;
  adapter: RuntimeAdapter;
  session: Session;
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
 * Per-connection task orchestration: offer -> claim -> (adapter session) ->
 * seq-ordered progress batches -> complete/fail, plus cancel/steer handling.
 *
 * Protocol-contract note (packages/protocol is frozen, not editable — see
 * the M0-3 report for the full writeup): `TASK_TRANSITIONS` only allows
 * `Offered -> Claimed | Cancelled`, and the daemon has no outbound message to
 * decline an offer pre-claim. So every fail-closed rejection (unknown/
 * disallowed runtime, policy exceeding the device ceiling, unsupported
 * blob-ref instruction) still claims first, then immediately fails —
 * claim-then-fail is the only wire-compliant way to decline. Similarly,
 * `Cancelled` is a distinct terminal `TaskState` but there is no outbound
 * message for it; cancellation is reported via
 * `task.fail({reason:'cancelled', retryable:false})` by convention.
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
        await this.handleOffer(envelope.payload);
        return;
      case 'task.cancel':
        await this.handleCancel(this.taskIdOf(envelope));
        return;
      case 'task.steer':
        await this.handleSteer(this.taskIdOf(envelope), envelope.payload.text);
        return;
      case 'task.approve':
        this.handleApprove(this.taskIdOf(envelope));
        return;
      case 'task.reject':
        await this.handleReject(this.taskIdOf(envelope), envelope.payload.reason);
        return;
      default:
        return; // conn.* and daemon->server-only types are handled elsewhere / not applicable
    }
  }

  private taskIdOf(envelope: Envelope): string {
    return envelope.task_id ?? '';
  }

  private async handleOffer(payload: TaskOfferPayload): Promise<void> {
    const taskId = payload.taskId;

    // Offered's only legal transitions are Claimed or Cancelled — claim
    // unconditionally first; every path below (success or fail-closed
    // rejection) reports its outcome from the Claimed state.
    this.deps.send(createEnvelope('task.claim', { taskId, deviceId: this.deps.deviceId }, { taskId }));

    if (typeof payload.instruction !== 'string') {
      await this.fail(taskId, 'blob-ref instructions are not supported in M0', false);
      return;
    }

    const pick = await this.pickAdapter(payload.runtime);
    if (!pick.ok) {
      await this.fail(taskId, pick.reason, pick.retryable);
      return;
    }

    const decision = computeEffectivePolicy(payload.policy, this.deps.permissionDefaults);
    if (!decision.ok) {
      await this.fail(taskId, decision.reason ?? 'policy rejected', false);
      return;
    }

    let workspaceDir: string;
    try {
      workspaceDir = await this.createWorkspaceDir(taskId);
    } catch (err) {
      await this.fail(taskId, `failed to create task workspace: ${errorMessage(err)}`, true);
      return;
    }

    const ctx: TaskContext = { workspaceDir, policy: decision.policy, env: process.env };

    let session: Session;
    try {
      session = await pick.adapter.start(payload, ctx);
    } catch (err) {
      // A PolicyUnsupportedError means this exact task can never succeed on
      // this adapter (fail-closed policy/instruction mismatch) — not
      // retryable. Anything else (spawn failure, missing credentials, etc)
      // is treated as environmental and possibly transient.
      const retryable = !(err instanceof PolicyUnsupportedError);
      await this.fail(taskId, `adapter failed to start: ${errorMessage(err)}`, retryable);
      return;
    }

    const active: ActiveTask = {
      taskId,
      adapter: pick.adapter,
      session,
      summaryParts: [],
      batcher: new ProgressBatcher(
        (seq, events) => this.deps.send(createEnvelope('task.progress', { seq, events }, { taskId, seq })),
        this.deps.batcherOptions,
      ),
    };
    this.tasks.set(taskId, active);
    void this.pump(active);
  }

  private async pump(active: ActiveTask): Promise<void> {
    try {
      for await (const event of active.session.events) {
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
        active.batcher.push(event);
      }
      // The events iterable ended without an explicit turn_end (e.g. the
      // underlying runtime process exited unexpectedly).
      await this.fail(active.taskId, 'runtime session ended without completing the task', true);
    } catch (err) {
      active.batcher.flush();
      await this.fail(active.taskId, `runtime error: ${errorMessage(err)}`, true);
    }
  }

  private async handleCancel(taskId: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return; // unknown or already-finished task
    try {
      await active.session.interrupt();
    } catch {
      // best-effort — still report cancellation below
    }
    active.batcher.flush();
    this.deps.send(createEnvelope('task.fail', { reason: 'cancelled', retryable: false }, { taskId }));
    await this.finish(taskId);
  }

  private async handleSteer(taskId: string, text: string): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    await active.session.steer(text);
  }

  /**
   * Records the approval locally. NOTE: the plan's Session interface
   * (steer/followUp/interrupt/close) has no method to forward an approve
   * decision into a running adapter session — see the M0-3 report's
   * protocol-gaps section. No M0 adapter emits `needs_approval`, so this is
   * currently unreachable in practice; kept for wire-level completeness and
   * to unblock future adapters that do.
   */
  private handleApprove(taskId: string): void {
    if (!this.tasks.has(taskId)) return;
  }

  private async handleReject(taskId: string, reason: string | undefined): Promise<void> {
    const active = this.tasks.get(taskId);
    if (!active) return;
    active.batcher.flush();
    this.deps.send(createEnvelope('task.fail', { reason: reason ?? 'rejected', retryable: false }, { taskId }));
    await this.finish(taskId);
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

  private async createWorkspaceDir(taskId: string): Promise<string> {
    const dir = path.join(this.deps.workspaceRoot, taskId);
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
