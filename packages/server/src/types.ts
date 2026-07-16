import type {
  AgentEvent,
  BlobRef,
  PermissionPolicy,
  RuntimeId,
  TaskArtifactPayload,
  TaskState,
} from '@byok/protocol';

/** Options for {@link createByokServer}. */
export interface CreateByokServerOptions {
  /**
   * Identifies which product this server instance serves. Checked against the
   * `productId` a daemon announces in `conn.hello` — one daemon process is
   * always scoped to one product (see plan: "一产品一 daemon 进程"), so a
   * mismatched daemon is rejected at handshake time.
   */
  productId: string;
}

/** Input to {@link ByokServer.dispatch}. */
export interface DispatchInput {
  instruction: string;
  runtime?: RuntimeId;
  policy?: PermissionPolicy;
  deviceId?: string;
  sessionRef?: string;
}

/** Outcome of a task that reached a terminal state. */
export interface TaskResult {
  state: Extract<TaskState, 'Complete' | 'Failed' | 'Cancelled'>;
  summary?: string;
  sessionRef?: string;
  artifactRefs?: BlobRef[];
  reason?: string;
  retryable?: boolean;
}

/**
 * Normalized event stream for a dispatched task: incoming `task.progress`
 * AgentEvents, state transitions, and artifacts, folded into one feed so a
 * consumer only has to read one `events()` iterable per task.
 */
export type ServerTaskEvent =
  | { kind: 'state'; state: TaskState; at: string }
  | { kind: 'agent'; event: AgentEvent }
  | { kind: 'artifact'; artifact: TaskArtifactPayload }
  | { kind: 'await_approval'; summary: string }
  | { kind: 'error'; reason: string; retryable?: boolean };

/** Handle returned by {@link ByokServer.dispatch} for one in-flight task. */
export interface TaskHandle {
  readonly taskId: string;
  events(): AsyncIterable<ServerTaskEvent>;
  cancel(reason?: string): Promise<void>;
  approve(): Promise<void>;
  reject(reason?: string): Promise<void>;
  steer(text: string): Promise<void>;
  result(): Promise<TaskResult>;
}

/** A device known to this server, joined from pairing identity + live connection state. */
export interface MachineInfo {
  deviceId: string;
  deviceName: string;
  connected: boolean;
  lastSeen?: string;
  runtimes?: RuntimeId[];
}

/** Snapshot of a task as tracked by the in-memory {@link TaskStore}. */
export interface TaskSnapshot {
  taskId: string;
  state: TaskState;
  instruction: string;
  runtime?: RuntimeId;
  policy: PermissionPolicy;
  deviceId?: string;
  sessionRef?: string;
  createdAt: string;
  updatedAt: string;
  result?: TaskResult;
}

/**
 * Cross-cutting server event feed (device connects/disconnects, task
 * creation/state changes) — the "event hub" from the plan's 服务端参考实现
 * section, as opposed to `TaskHandle.events()` which is scoped to one task.
 * Not part of the pinned wire contract; a server-embedder-facing convenience.
 */
export type ByokServerEvent =
  | { kind: 'device.connected'; deviceId: string; at: string }
  | { kind: 'device.disconnected'; deviceId: string; at: string }
  | { kind: 'task.created'; taskId: string; at: string }
  | { kind: 'task.state'; taskId: string; state: TaskState; at: string };
