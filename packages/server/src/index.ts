import type { Server as HttpServer } from 'node:http';
import type { Hono } from 'hono';
import { buildHonoApp } from './http';
import { ConnectionHub } from './hub';
import { PairingManager, type PairingCodeInfo } from './pairing';
import { TaskStore } from './task-store';
import { attachWebSocket as attachWsUpgrade } from './ws-server';
import type {
  ByokServerEvent,
  CreateByokServerOptions,
  DispatchInput,
  MachineInfo,
  TaskHandle,
  TaskSnapshot,
} from './types';

export type {
  ByokServerEvent,
  CreateByokServerOptions,
  DispatchInput,
  MachineInfo,
  ServerTaskEvent,
  TaskHandle,
  TaskResult,
  TaskSnapshot,
} from './types';
export { IllegalTaskTransitionError } from './task-store';
export { PairingCodeInvalidError } from './pairing';

/** The object `createByokServer` returns — the SaaS-embedder-facing surface. */
export interface ByokServer {
  /** Hono app exposing `POST /byok/pair`. Mount it, or use its `.fetch` with `@hono/node-server`. */
  hono: Hono;
  /** Wire up the `GET /byok/ws` upgrade on the raw Node HTTP server serving `hono`. */
  attachWebSocket(server: HttpServer): void;
  pairing: {
    createPairingCode(): PairingCodeInfo;
  };
  dispatch(input: DispatchInput): Promise<TaskHandle>;
  tasks: {
    get(taskId: string): TaskSnapshot | undefined;
    list(): TaskSnapshot[];
  };
  machines: {
    list(): MachineInfo[];
  };
  events: {
    subscribe(): AsyncIterable<ByokServerEvent>;
  };
}

/**
 * M0 in-memory reference implementation of the SaaS-side coordinator: device
 * pairing, a WS connection hub, and task dispatch/lifecycle tracking. See the
 * per-module doc comments (`pairing.ts`, `hub.ts`, `task-store.ts`,
 * `ws-server.ts`) for the M0 simplifications this deliberately makes (no
 * device keypairs/JWT, no long-poll fallback, no blob store, no redelivery
 * cursor).
 */
export function createByokServer(opts: CreateByokServerOptions): ByokServer {
  const pairing = new PairingManager();
  const taskStore = new TaskStore();
  const hub = new ConnectionHub(taskStore, pairing);
  const hono = buildHonoApp({ pairing });

  return {
    hono,
    attachWebSocket(server: HttpServer): void {
      attachWsUpgrade(server, { pairing, hub, productId: opts.productId });
    },
    pairing: {
      createPairingCode: () => pairing.createPairingCode(),
    },
    dispatch: (input: DispatchInput) => hub.dispatch(input),
    tasks: {
      get: (taskId: string) => hub.getTask(taskId),
      list: () => hub.listTasks(),
    },
    machines: {
      list: () => hub.listMachines(),
    },
    events: {
      subscribe: () => hub.subscribeServerEvents(),
    },
  };
}
