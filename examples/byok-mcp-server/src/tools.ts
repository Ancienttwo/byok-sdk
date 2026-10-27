import { setTimeout as delay } from 'node:timers/promises';
import type { AgentExecutionInput, ByokServer, MachineInfo, TaskSnapshot } from '@byok-sdk/server';
import { RequiredToolsetsSchema, TASK_STATES, type RuntimeId, type TaskState } from '@byok-sdk/protocol';
import type { ScopedTool } from './http';
import type { BetaLedger } from './ledger';
import { BetaError, canonicalJson, invalid, object, taskArguments, text, type Caller, type KeyInfo, type TaskArguments,
  type TaskReservation } from './model';

/** The public SDK surface the task tools use. The Host passes its own `createByokServer` instance. */
export type TaskToolServer = Pick<ByokServer, 'executions' | 'tasks' | 'blobs' | 'machines'>;
export interface TaskToolOptions {
  readonly sdk: TaskToolServer;
  readonly ledger: BetaLedger;
  /** The Host's egress policy for task executions. The device must accept it. */
  readonly egressPolicy: AgentExecutionInput['payload']['egressPolicy'];
  /** Absolute origin where the Host serves the SDK routes. Blob download paths resolve against it. */
  readonly blobBaseUrl: string;
  /** Pause between task reads while `byok_task_status` waits. Default 500 ms. */
  readonly statusPollMs?: number;
}

const MAX_STATUS_WAIT_SECONDS = 50;
const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;
const TERMINAL: ReadonlySet<TaskState> = new Set(['Complete', 'Failed', 'Cancelled']);
/** Ledger-only states: admitted but not in the SDK yet, or released and no longer readable there. */
const VIEW_STATES = [...TASK_STATES, 'Reserved', 'Unknown'] as const;
type ViewState = typeof VIEW_STATES[number];

export function json(value: unknown): Record<string, unknown> { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
export function input(args: Readonly<Record<string, unknown>> | undefined, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  const value = object(args ?? {});
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => value[key] === undefined)) invalid();
  return value;
}
export function integer(value: unknown, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
const taskIdProperty = { type: 'string', description: 'A taskId that byok_task_submit returned to this key.' } as const;

/** Ranks granted devices: runtime advertised now, then offline (queued work), then online without it. */
export async function selectDevice(sdk: Pick<ByokServer, 'machines'>, key: KeyInfo, runtime: RuntimeId): Promise<string> {
  const machines = new Map((await sdk.machines.list()).map(machine => [machine.deviceId, machine]));
  const rank = (machine: MachineInfo) => machine.runtimes?.some(fact => fact.id === runtime) ? 0 : machine.connected ? 2 : 1;
  const granted = key.deviceIds.flatMap(id => machines.get(id) ?? []).sort((a, b) => rank(a) - rank(b));
  if (!granted[0]) throw new BetaError('unavailable', 'No granted device is registered', 60);
  return granted[0].deviceId;
}

/** The B3 task catalogue. Each handler reaches the SDK only through the caller's saved ledger reservations. */
export function createTaskTools(options: TaskToolOptions): ScopedTool[] {
  const { sdk, ledger } = options;
  const blobBase = new URL(options.blobBaseUrl);
  // Download URLs carry a signature: HTTPS, or loopback HTTP, as for the MCP origin.
  if (blobBase.origin !== options.blobBaseUrl.replace(/\/$/, '') || blobBase.protocol !== 'https:'
    && !(blobBase.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(blobBase.hostname))) {
    throw new TypeError('Select the HTTPS or loopback HTTP origin of the SDK routes');
  }
  const pollMs = integer(options.statusPollMs, 10, 10_000, 500);

  /** The SDK snapshot of a saved reservation. A snapshot for another device is corrupt state, not this task. */
  async function read(reservation: TaskReservation): Promise<TaskSnapshot | undefined> {
    const snapshot = await sdk.tasks.get(reservation.taskId);
    if (snapshot?.deviceId !== undefined && snapshot.deviceId !== reservation.binding.deviceId) throw new Error('SDK task does not match the saved binding');
    return snapshot;
  }
  /** Frees the slot when the SDK has an exact device terminal. Host cancellation alone frees nothing. */
  async function settle(reservation: TaskReservation, snapshot: TaskSnapshot | undefined): Promise<void> {
    if (snapshot && TERMINAL.has(snapshot.state) && !reservation.slotReleased) await ledger.reconcileTask(reservation.taskId);
  }
  function view(reservation: TaskReservation, snapshot: TaskSnapshot | undefined) {
    const state: ViewState = snapshot?.state ?? (reservation.slotReleased ? 'Unknown' : 'Reserved');
    const result = snapshot?.result;
    return { taskId: reservation.taskId, state,
      ...(result?.finalMessage === undefined ? {} : { finalMessage: result.finalMessage }),
      ...(result?.document === undefined ? {} : { document: result.document }),
      artifacts: (result?.artifactRefs ?? []).map((ref, index) => ({ index, contentType: ref.contentType, size: ref.size })),
      ...(result?.reason === undefined ? {} : { reason: result.reason }),
      ...(result?.code === undefined ? {} : { code: result.code }),
      ...(result?.retryable === undefined ? {} : { retryable: result.retryable }) };
  }

  /** The binding's AgentRef. The ledger admits `tasks.dispatch` only for keys with one, so a missing one is corrupt state. */
  function bindingAgent(reservation: TaskReservation): NonNullable<TaskReservation['binding']['agentRef']> {
    const agentRef = reservation.binding.agentRef;
    if (!agentRef) throw new Error('Saved task binding has no AgentRef');
    return agentRef;
  }
  function verifyOffer(offer: NonNullable<Awaited<ReturnType<TaskToolServer['tasks']['offer']>>>, reservation: TaskReservation): void {
    const args = reservation.binding.arguments;
    if (offer.type !== 'task.offer_for_agent_with_egress_fresh' || offer.taskId !== reservation.taskId
      || offer.deviceId !== reservation.binding.deviceId
      || canonicalJson(offer.payload.agentRef) !== canonicalJson(bindingAgent(reservation))
      || offer.payload.instruction !== args.instruction || offer.payload.runtime !== args.runtime
      || canonicalJson(offer.payload.requiredToolsets ?? null) !== canonicalJson(args.toolsets ?? null)) {
      throw new Error('SDK offer does not match the saved task binding');
    }
  }
  /** Submits a saved, unreleased reservation once as a fresh Agent execution. A conflict counts only after exact offer readback. */
  async function ensureDispatched(reservation: TaskReservation): Promise<void> {
    const existing = await sdk.tasks.offer(reservation.taskId);
    if (existing) return verifyOffer(existing, reservation);
    const args = reservation.binding.arguments;
    const agentRef = bindingAgent(reservation);
    try {
      await sdk.executions.submit({ taskId: reservation.taskId, deviceId: reservation.binding.deviceId, payload: {
        runtime: args.runtime, instruction: args.instruction, agentRef,
        egressPolicy: options.egressPolicy, terminalProjection: { mode: 'none' },
        ...(args.toolsets ? { requiredToolsets: [...args.toolsets] } : {}) } });
    } catch {
      const offered = await sdk.tasks.offer(reservation.taskId);
      if (!offered) throw new BetaError('unavailable', 'The task was admitted but not dispatched. Retry the same call.', 1);
      verifyOffer(offered, reservation);
    }
  }
  async function reconcileOpen(caller: Caller): Promise<void> {
    for (const taskId of ledger.openTasks(caller)) await ledger.reconcileTask(taskId);
  }
  function submitArguments(args: Readonly<Record<string, unknown>> | undefined): TaskArguments {
    const parsed = taskArguments(args ?? {});
    // Task executions submit terminalProjection `none` and define no result contract (routines do). The SDK has no workspace selection.
    if (parsed.resultSchema !== undefined) throw new BetaError('invalid_input', 'resultSchema is not available for beta task dispatch');
    if (parsed.workspace !== undefined) throw new BetaError('invalid_input', 'workspace selection is not available for beta task dispatch');
    // The SDK takes 1-16 distinct toolset ids; anything else would hold a slot for a dispatch it refuses.
    if (parsed.toolsets !== undefined && !RequiredToolsetsSchema.safeParse(parsed.toolsets).success) invalid();
    return parsed;
  }

  return [
    {
      scope: 'authenticated',
      definition: { name: 'byok_whoami', description: 'Describe this byok bot key: label, scopes, granted devices and runtimes, and quota use now.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      async call(caller, args) {
        input(args, []);
        const key = ledger.authorize(caller);
        await reconcileOpen(caller);
        const machines = new Map((await sdk.machines.list()).map(machine => [machine.deviceId, machine]));
        return json({ keyId: key.keyId, label: key.label, scopes: key.scopes, runtimes: key.runtimes,
          devices: key.deviceIds.map(deviceId => {
            const machine = machines.get(deviceId);
            return machine ? { deviceId, name: machine.deviceName, registered: true, connected: machine.connected } : { deviceId, registered: false };
          }),
          quota: { limits: key.quota, now: ledger.quota(caller) } });
      },
    },
    {
      scope: 'tasks.read',
      definition: { name: 'byok_runtimes', description: 'List the coding-agent runtimes this key may use on each granted device, and whether the device reports them installed now.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      async call(caller, args) {
        input(args, []);
        const key = ledger.authorize(caller, 'tasks.read');
        const machines = new Map((await sdk.machines.list()).map(machine => [machine.deviceId, machine]));
        return json({ devices: key.deviceIds.map(deviceId => {
          const machine = machines.get(deviceId);
          return { deviceId, registered: machine !== undefined, connected: machine?.connected ?? false,
            runtimes: key.runtimes.map(id => {
              const fact = machine?.runtimes?.find(item => item.id === id);
              // Runtime facts exist only while the device's presence is fresh; otherwise installation is unknown.
              return { id, installed: machine?.runtimes === undefined ? null : fact !== undefined,
                ...(fact?.version === undefined ? {} : { version: fact.version }),
                ...(fact?.authPresent === undefined ? {} : { authPresent: fact.authPresent }) };
            }) };
        }) });
      },
    },
    {
      scope: 'tasks.dispatch',
      definition: { name: 'byok_task_submit',
        description: 'Start a coding task on a paired byok device. Returns at once with a taskId; poll byok_task_status for the result. '
          + 'A retry of the same call returns the same task (deduplicated: true). To run the same instruction again on purpose within 15 minutes, send a new clientRequestId, or the earlier task comes back.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['runtime', 'instruction'], properties: {
          runtime: { type: 'string', description: 'A runtime this key may use (see byok_runtimes).' },
          instruction: { type: 'string', description: 'The task for the coding agent. At most 32 KiB.' },
          toolsets: { type: 'array', items: { type: 'string' }, description: 'Device-configured MCP toolset ids the task needs.' },
          clientRequestId: { type: 'string', description: 'Optional retry key. The same id always returns the same task.' },
        } } },
      async call(caller, args) {
        const parsed = submitArguments(args);
        let reservation = ledger.lookupTask(caller, parsed);
        if (!reservation) {
          await reconcileOpen(caller);
          reservation = ledger.reserveTask(caller, parsed, await selectDevice(sdk, ledger.authorize(caller, 'tasks.dispatch'), parsed.runtime));
        }
        // A released reservation already reached a device terminal: read it back, never dispatch it again.
        if (!reservation.slotReleased) await ensureDispatched(reservation);
        const snapshot = await read(reservation);
        return json({ taskId: reservation.taskId, state: view(reservation, snapshot).state, deduplicated: reservation.deduplicated });
      },
    },
    {
      scope: 'tasks.read',
      definition: { name: 'byok_task_status',
        description: `Read a task's state and outcome. With waitSeconds (0-${MAX_STATUS_WAIT_SECONDS}) it waits until the state changes or the time ends; call it again to keep waiting.`,
        inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: {
          taskId: taskIdProperty, waitSeconds: { type: 'integer', minimum: 0, maximum: MAX_STATUS_WAIT_SECONDS },
        } } },
      async call(caller, args, signal) {
        const value = input(args, ['taskId', 'waitSeconds'], ['taskId']);
        const taskId = text(value.taskId); const waitSeconds = integer(value.waitSeconds, 0, MAX_STATUS_WAIT_SECONDS, 0);
        ledger.consumeStatusRead(caller, taskId);
        const reservation = ledger.requireTask(caller, taskId);
        let snapshot = await read(reservation);
        const initial = snapshot?.state;
        const deadline = Date.now() + waitSeconds * 1000;
        while (initial !== undefined && !TERMINAL.has(initial) && snapshot?.state === initial && Date.now() < deadline && !signal.aborted) {
          await delay(Math.min(pollMs, deadline - Date.now()), undefined, { signal }).catch(() => undefined);
          if (!signal.aborted) snapshot = await read(reservation);
        }
        await settle(reservation, snapshot);
        return json(view(reservation, snapshot));
      },
    },
    {
      scope: 'tasks.cancel',
      definition: { name: 'byok_task_cancel', description: 'Cancel a task. Safe to repeat; a finished task keeps its final state. '
          + 'A Reserved task never reached a device: cancel leaves it Reserved, and a retry of the same byok_task_submit still starts it.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: {
          taskId: taskIdProperty, reason: { type: 'string', description: 'Optional short reason, at most 512 bytes.' },
        } } },
      async call(caller, args) {
        const value = input(args, ['taskId', 'reason'], ['taskId']);
        const reservation = ledger.requireTask(caller, text(value.taskId), 'tasks.cancel');
        const reason = value.reason === undefined ? 'Cancelled by the external Bot' : text(value.reason, 512);
        let snapshot = await read(reservation);
        if (snapshot && !TERMINAL.has(snapshot.state)) {
          await sdk.tasks.cancel(reservation.taskId, reason);
          snapshot = await read(reservation);
        }
        await settle(reservation, snapshot);
        return json({ taskId: reservation.taskId, state: view(reservation, snapshot).state });
      },
    },
    {
      scope: 'tasks.read',
      definition: { name: 'byok_task_list', description: 'List the tasks this key submitted, newest first.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {
          cursor: { type: 'string', description: 'nextCursor from the previous page.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
          state: { type: 'string', enum: [...VIEW_STATES], description: 'Keep only tasks in this state. A page can then hold fewer than limit items; continue while nextCursor is present.' },
        } } },
      async call(caller, args) {
        const value = input(args, ['cursor', 'limit', 'state']);
        const state = value.state === undefined ? undefined : VIEW_STATES.find(item => item === value.state) ?? invalid();
        const page = ledger.listTasks(caller, { limit: integer(value.limit, 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT),
          ...(value.cursor === undefined ? {} : { cursor: text(value.cursor) }) });
        const tasks = [];
        for (const reservation of page.tasks) {
          const snapshot = await read(reservation);
          await settle(reservation, snapshot);
          const item = { taskId: reservation.taskId, runtime: reservation.binding.arguments.runtime,
            createdAt: new Date(reservation.createdAt).toISOString(), state: view(reservation, snapshot).state };
          if (state === undefined || item.state === state) tasks.push(item);
        }
        return json({ tasks, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      },
    },
    {
      scope: 'artifacts.read',
      definition: { name: 'byok_artifact_url', description: 'Get a short-lived download URL for one artifact of a finished task (index from byok_task_status).',
        inputSchema: { type: 'object', additionalProperties: false, required: ['taskId', 'index'], properties: {
          taskId: taskIdProperty, index: { type: 'integer', minimum: 0 },
        } } },
      async call(caller, args) {
        const value = input(args, ['taskId', 'index'], ['taskId', 'index']);
        const reservation = ledger.requireTask(caller, text(value.taskId), 'artifacts.read');
        const index = integer(value.index, 0, 1_000_000);
        const ref = (await read(reservation))?.result?.artifactRefs?.[index];
        const path = ref === undefined ? undefined : await sdk.blobs.getDownloadUrl(ref.blobId);
        if (!ref || path === undefined) throw new BetaError('not_found', 'Resource not found');
        return json({ taskId: reservation.taskId, index, url: new URL(path, blobBase).href, contentType: ref.contentType, size: ref.size });
      },
    },
  ];
}
