import type { WebSocket } from 'ws';
import {
  canTransition,
  createEnvelope,
  encodeEnvelope,
  type Envelope,
  type PermissionPolicy,
  type RuntimeId,
  type TaskArtifactPayload,
  type TaskAwaitApprovalPayload,
  type TaskClaimPayload,
  type TaskCompletePayload,
  type TaskFailPayload,
  type TaskProgressPayload,
  type TaskState,
} from '@byok/protocol';
import { AsyncEventQueue } from './event-queue';
import { generateTaskId } from './ids';
import type { PairingManager } from './pairing';
import { TaskStore } from './task-store';
import type {
  ByokServerEvent,
  DispatchInput,
  MachineInfo,
  ServerTaskEvent,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';

/**
 * M0 default policy when `dispatch()` is called without one. `TaskOfferPayload.policy`
 * is required on the wire even though our `dispatch()` input makes it optional, so we
 * need a safe default. Per the plan's fail-closed principle ("越权需要本地确认"),
 * default to `confirm` rather than the more permissive `auto`.
 */
const DEFAULT_POLICY: PermissionPolicy = { mode: 'confirm' };

const KNOWN_RUNTIMES = new Set<RuntimeId>(['pi', 'claude', 'codex']);

/** Best-effort normalization of `conn.hello`'s untyped `agents` field into RuntimeIds. */
function normalizeRuntimes(agents: unknown): RuntimeId[] | undefined {
  if (!Array.isArray(agents)) return undefined;
  const runtimes = agents.filter(
    (a): a is RuntimeId => typeof a === 'string' && KNOWN_RUNTIMES.has(a as RuntimeId),
  );
  return runtimes.length > 0 ? runtimes : undefined;
}

function isTerminal(state: TaskState): state is Extract<TaskState, 'Complete' | 'Failed' | 'Cancelled'> {
  return state === 'Complete' || state === 'Failed' || state === 'Cancelled';
}

interface ConnectionState {
  ws: WebSocket;
  connected: boolean;
  lastSeen: string;
  runtimes?: RuntimeId[];
}

interface TaskRuntime {
  queue: AsyncEventQueue<ServerTaskEvent>;
  resolveResult: (result: TaskResult) => void;
  result: Promise<TaskResult>;
}

/** Fields hub.ts ever patches alongside a state transition. */
type TaskPatch = Partial<Pick<TaskSnapshot, 'deviceId' | 'sessionRef' | 'result'>>;

/**
 * The connection hub: tracks live per-device WebSocket connections, routes
 * `dispatch()`'d tasks to a device, and processes inbound task.* envelopes
 * from daemons.
 *
 * Protocol note (see also errors surfaced in the M0 report): `task.progress`
 * / `task.artifact` / `task.await_approval` / `task.complete` / `task.fail`
 * payloads carry no `taskId` of their own — only the envelope's *optional*
 * `task_id` field identifies which task they belong to. A daemon that omits
 * `task_id` on these produces a validly-parsed envelope this server cannot
 * route; see `withEnvelopeTaskId` below.
 *
 * State-machine note: the wire has no distinct "task started running"
 * message. This hub treats `task.claim` as claiming *and* immediately
 * starting the task (`Offered -> Claimed -> Running`, two legal hops applied
 * back to back) rather than waiting for the first `task.progress` — simpler
 * than special-casing a Claimed->Running bump in every subsequent handler,
 * and just as protocol-legal.
 */
export class ConnectionHub {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly serverEvents = new AsyncEventQueue<ByokServerEvent>();

  constructor(
    private readonly taskStore: TaskStore,
    private readonly pairing: PairingManager,
  ) {}

  /** The top-level `events` feed returned by `createByokServer` — see {@link ByokServerEvent}. */
  subscribeServerEvents(): AsyncIterable<ByokServerEvent> {
    return this.serverEvents.subscribe();
  }

  // ---------------------------------------------------------------------
  // connection lifecycle — called from ws-server.ts
  // ---------------------------------------------------------------------

  registerConnection(deviceId: string, ws: WebSocket, agents: unknown): void {
    const at = new Date().toISOString();
    this.connections.set(deviceId, {
      ws,
      connected: true,
      lastSeen: at,
      runtimes: normalizeRuntimes(agents),
    });
    this.serverEvents.push({ kind: 'device.connected', deviceId, at });
  }

  /**
   * M0 simplification: no redelivery cursor. A task still in flight for a
   * device that just disconnected can't be resumed, so it's terminated:
   * `Offered` (never claimed) -> `Cancelled` (Failed isn't a legal target
   * from `Offered`); anything already claimed -> `Failed` with
   * `retryable: true`, per the M0 spec.
   */
  handleDisconnect(deviceId: string): void {
    const conn = this.connections.get(deviceId);
    if (conn) {
      conn.connected = false;
      conn.lastSeen = new Date().toISOString();
      this.serverEvents.push({ kind: 'device.disconnected', deviceId, at: conn.lastSeen });
    }
    for (const record of this.taskStore.list()) {
      if (record.deviceId !== deviceId) continue;
      if (record.state === 'Offered') {
        this.applyOrFail(record.taskId, 'Cancelled', {
          result: { state: 'Cancelled', reason: 'device disconnected before claim' },
        });
      } else if (record.state === 'Claimed' || record.state === 'Running' || record.state === 'AwaitApproval') {
        this.applyOrFail(record.taskId, 'Failed', {
          result: { state: 'Failed', reason: 'device disconnected', retryable: true },
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // inbound envelopes from a connected daemon
  // ---------------------------------------------------------------------

  handleEnvelope(deviceId: string, envelope: Envelope): void {
    switch (envelope.type) {
      case 'task.claim':
        this.onClaim(deviceId, envelope.payload);
        return;
      case 'task.progress':
        this.withEnvelopeTaskId(envelope, (taskId) => this.onProgress(taskId, envelope.payload));
        return;
      case 'task.artifact':
        this.withEnvelopeTaskId(envelope, (taskId) => this.onArtifact(taskId, envelope.payload));
        return;
      case 'task.await_approval':
        this.withEnvelopeTaskId(envelope, (taskId) => this.onAwaitApproval(taskId, envelope.payload));
        return;
      case 'task.complete':
        this.withEnvelopeTaskId(envelope, (taskId) => this.onComplete(taskId, envelope.payload));
        return;
      case 'task.fail':
        this.withEnvelopeTaskId(envelope, (taskId) => this.onFail(taskId, envelope.payload));
        return;
      default:
        // conn.hello is handled during the handshake (ws-server.ts); the
        // remaining types (conn.ack/task.offer/approve/reject/cancel/steer)
        // are server->daemon only. Ignore rather than crash the connection —
        // additive future message types must be tolerated too.
        return;
    }
  }

  private withEnvelopeTaskId(envelope: Envelope, fn: (taskId: string) => void): void {
    const taskId = envelope.task_id;
    if (!taskId) {
      console.warn(
        `[byok/server] dropping ${envelope.type}: envelope.task_id is missing (this payload type carries no taskId of its own)`,
      );
      return;
    }
    fn(taskId);
  }

  private onClaim(deviceId: string, payload: TaskClaimPayload): void {
    const record = this.taskStore.get(payload.taskId);
    if (!record) return;
    if (record.deviceId !== deviceId || payload.deviceId !== deviceId) {
      this.forceFailOrDrop(payload.taskId, 'claim from unexpected device');
      return;
    }
    // Claim is an idempotent CAS (plan: "claim 为幂等 CAS"): a retried claim
    // from the device that already owns this task (e.g. the daemon didn't
    // see the first claim's effect land before retrying) is a no-op, not an
    // illegal-transition failure.
    if (record.state === 'Claimed' || record.state === 'Running') return;
    this.applyOrFail(payload.taskId, 'Claimed', { deviceId });
    this.applyOrFail(payload.taskId, 'Running', {});
  }

  private onProgress(taskId: string, payload: TaskProgressPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (record.state !== 'Running') {
      this.forceFailOrDrop(taskId, 'task.progress received while not Running');
      return;
    }
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return;
    for (const event of payload.events) {
      runtime.queue.push({ kind: 'agent', event });
    }
  }

  private onArtifact(taskId: string, payload: TaskArtifactPayload): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (record.state !== 'Running') {
      this.forceFailOrDrop(taskId, 'task.artifact received while not Running');
      return;
    }
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return;
    runtime.queue.push({ kind: 'artifact', artifact: payload });
  }

  private onAwaitApproval(taskId: string, payload: TaskAwaitApprovalPayload): void {
    this.applyOrFail(taskId, 'AwaitApproval', {});
    const after = this.taskStore.get(taskId);
    if (after?.state !== 'AwaitApproval') return; // fell back to Failed, or task was unknown
    this.runtimes.get(taskId)?.queue.push({ kind: 'await_approval', summary: payload.summary });
  }

  private onComplete(taskId: string, payload: TaskCompletePayload): void {
    const result: TaskResult = {
      state: 'Complete',
      summary: payload.summary,
      sessionRef: payload.sessionRef,
      artifactRefs: payload.artifactRefs,
    };
    this.applyOrFail(taskId, 'Complete', { result, sessionRef: payload.sessionRef });
  }

  private onFail(taskId: string, payload: TaskFailPayload): void {
    const result: TaskResult = { state: 'Failed', reason: payload.reason, retryable: payload.retryable };
    this.applyOrFail(taskId, 'Failed', { result });
  }

  // ---------------------------------------------------------------------
  // transition helpers — the single place "illegal transition" is handled
  // ---------------------------------------------------------------------

  /**
   * Apply `taskId`'s state -> `target`. If that's illegal per
   * `TASK_TRANSITIONS`, fall back to `Failed` (if reachable from the current
   * state); this is the "illegal transition = error + task.fail path" rule.
   */
  private applyOrFail(taskId: string, target: TaskState, patch: TaskPatch): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (canTransition(record.state, target)) {
      const updated = this.taskStore.transition(taskId, target, patch);
      this.onStateChange(updated);
      return;
    }
    this.forceFailOrDrop(taskId, `illegal transition ${record.state} -> ${target}`);
  }

  /**
   * A daemon message didn't fit the task's current state (e.g. progress
   * while AwaitApproval). Force the task to `Failed` if that's reachable;
   * otherwise it's already terminal (or `Offered`, which has no Failed edge)
   * and there's nothing safe to do but log + drop.
   */
  private forceFailOrDrop(taskId: string, reason: string): void {
    const record = this.taskStore.get(taskId);
    if (!record) return;
    if (canTransition(record.state, 'Failed')) {
      const updated = this.taskStore.transition(taskId, 'Failed', {
        result: { state: 'Failed', reason, retryable: false },
      });
      this.onStateChange(updated);
      return;
    }
    console.warn(`[byok/server] dropping message for ${taskId} (state ${record.state}): ${reason}`);
  }

  private onStateChange(record: TaskSnapshot): void {
    this.serverEvents.push({ kind: 'task.state', taskId: record.taskId, state: record.state, at: record.updatedAt });
    const runtime = this.runtimes.get(record.taskId);
    if (!runtime) return;
    runtime.queue.push({ kind: 'state', state: record.state, at: record.updatedAt });
    if (isTerminal(record.state)) {
      runtime.resolveResult(record.result ?? { state: record.state });
      runtime.queue.close();
    }
  }

  // ---------------------------------------------------------------------
  // dispatch() and the TaskHandle it returns
  // ---------------------------------------------------------------------

  async dispatch(input: DispatchInput): Promise<TaskHandle> {
    const deviceId = input.deviceId ?? this.pickFirstConnectedDevice();
    // M0 routing has no queue-until-connect: reject clearly instead of
    // silently queuing a task nothing will ever claim.
    if (!deviceId || !this.connections.get(deviceId)?.connected) {
      throw new Error(
        deviceId
          ? `device ${deviceId} is not connected`
          : 'no connected device to dispatch to (M0 does not queue tasks until a device connects)',
      );
    }

    const taskId = generateTaskId();
    const policy = input.policy ?? DEFAULT_POLICY;
    const record = this.taskStore.create({
      taskId,
      instruction: input.instruction,
      runtime: input.runtime,
      policy,
      deviceId,
      sessionRef: input.sessionRef,
    });

    const queue = new AsyncEventQueue<ServerTaskEvent>();
    let resolveResult!: (result: TaskResult) => void;
    const result = new Promise<TaskResult>((resolve) => {
      resolveResult = resolve;
    });
    this.runtimes.set(taskId, { queue, resolveResult, result });
    queue.push({ kind: 'state', state: record.state, at: record.createdAt });
    this.serverEvents.push({ kind: 'task.created', taskId, at: record.createdAt });

    this.sendEnvelope(
      deviceId,
      createEnvelope(
        'task.offer',
        {
          taskId,
          instruction: input.instruction,
          policy,
          runtime: input.runtime,
          sessionRef: input.sessionRef,
        },
        { taskId, sessionRef: input.sessionRef },
      ),
    );

    return this.buildTaskHandle(taskId);
  }

  private buildTaskHandle(taskId: string): TaskHandle {
    const hub = this;
    return {
      taskId,
      events(): AsyncIterable<ServerTaskEvent> {
        const runtime = hub.runtimes.get(taskId);
        if (!runtime) throw new Error(`unknown taskId: ${taskId}`);
        return runtime.queue.subscribe();
      },
      cancel(reason?: string): Promise<void> {
        return hub.cancelTask(taskId, reason);
      },
      approve(): Promise<void> {
        return hub.approveTask(taskId);
      },
      reject(reason?: string): Promise<void> {
        return hub.rejectTask(taskId, reason);
      },
      steer(text: string): Promise<void> {
        return hub.steerTask(taskId, text);
      },
      result(): Promise<TaskResult> {
        const runtime = hub.runtimes.get(taskId);
        if (!runtime) throw new Error(`unknown taskId: ${taskId}`);
        return runtime.result;
      },
    };
  }

  /** Idempotent: cancelling an already-terminal task is a no-op, not an error. */
  private async cancelTask(taskId: string, reason?: string): Promise<void> {
    const record = this.taskStore.get(taskId);
    if (!record) throw new Error(`unknown taskId: ${taskId}`);
    if (isTerminal(record.state)) return;
    // The protocol defines no daemon ack for task.cancel, so the server-side
    // Cancelled state is authoritative immediately; task.cancel is forwarded
    // as a best-effort notification for the daemon to stop local work.
    this.applyOrFail(taskId, 'Cancelled', { result: { state: 'Cancelled', reason } });
    if (record.deviceId) {
      this.sendEnvelope(record.deviceId, createEnvelope('task.cancel', { reason }, { taskId }));
    }
  }

  private async approveTask(taskId: string): Promise<void> {
    const record = this.taskStore.get(taskId);
    if (!record) throw new Error(`unknown taskId: ${taskId}`);
    if (record.state !== 'AwaitApproval') {
      throw new Error(`cannot approve task ${taskId}: not awaiting approval (state ${record.state})`);
    }
    this.applyOrFail(taskId, 'Running', {});
    if (record.deviceId) {
      this.sendEnvelope(record.deviceId, createEnvelope('task.approve', {}, { taskId }));
    }
  }

  private async rejectTask(taskId: string, reason?: string): Promise<void> {
    const record = this.taskStore.get(taskId);
    if (!record) throw new Error(`unknown taskId: ${taskId}`);
    if (record.state !== 'AwaitApproval') {
      throw new Error(`cannot reject task ${taskId}: not awaiting approval (state ${record.state})`);
    }
    this.applyOrFail(taskId, 'Failed', {
      result: { state: 'Failed', reason: reason ?? 'approval rejected', retryable: false },
    });
    if (record.deviceId) {
      this.sendEnvelope(record.deviceId, createEnvelope('task.reject', { reason }, { taskId }));
    }
  }

  private async steerTask(taskId: string, text: string): Promise<void> {
    const record = this.taskStore.get(taskId);
    if (!record) throw new Error(`unknown taskId: ${taskId}`);
    if (record.state !== 'Running') {
      throw new Error(`cannot steer task ${taskId}: not running (state ${record.state})`);
    }
    if (!record.deviceId || !this.sendEnvelope(record.deviceId, createEnvelope('task.steer', { text }, { taskId }))) {
      throw new Error(`device for task ${taskId} is not connected`);
    }
  }

  private pickFirstConnectedDevice(): string | undefined {
    for (const [deviceId, conn] of this.connections) {
      if (conn.connected) return deviceId;
    }
    return undefined;
  }

  private sendEnvelope(deviceId: string, envelope: Envelope): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || !conn.connected) return false;
    conn.ws.send(encodeEnvelope(envelope));
    return true;
  }

  // ---------------------------------------------------------------------
  // read-only accessors backing the public `machines` / `tasks` API
  // ---------------------------------------------------------------------

  listMachines(): MachineInfo[] {
    return this.pairing.listDeviceIds().map((deviceId) => {
      const conn = this.connections.get(deviceId);
      return {
        deviceId,
        deviceName: this.pairing.getDeviceName(deviceId) ?? '(unknown)',
        connected: conn?.connected ?? false,
        lastSeen: conn?.lastSeen,
        runtimes: conn?.runtimes,
      };
    });
  }

  getTask(taskId: string): TaskSnapshot | undefined {
    return this.taskStore.get(taskId);
  }

  listTasks(): TaskSnapshot[] {
    return this.taskStore.list();
  }
}
