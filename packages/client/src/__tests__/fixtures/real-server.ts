import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import type { AgentRef, RuntimeId } from '@byok-sdk/protocol';
import { expect, vi } from 'vitest';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../../daemon/agent-egress-policy';
import type { StubRuntimeAdapter, StubSession } from './stub-adapter';
import {
  createByokServer,
  type ByokServer,
  type DispatchInput,
  type CreateByokServerOptions,
  type PairingCodeInfo,
  type ServerTaskEvent,
  type TaskHandle,
} from '@byok-sdk/server';

/**
 * Boots the REAL `@byok-sdk/server` reference implementation (not the
 * lightweight `TestServer` stub the rest of this package's tests use) on an
 * ephemeral loopback port, for the small set of tests that specifically
 * need genuine cross-package client<->server behavior rather than a
 * hand-rolled approximation of it — e.g. finding F2 (redelivery depends on
 * the real server's exact mailbox cursor semantics) and finding F5 (a fresh
 * `deviceId` per `/byok/pair` call is the real server's actual behavior,
 * which the client-side `TestServer` stub deliberately does not reproduce —
 * see its own doc comment).
 *
 * `@byok-sdk/server` is a façade over `@byok-sdk/cloud` and serves
 * `GET /byok/events` + `POST /byok/messages`. A daemon pointed at this
 * server has one start mode: long-poll.
 */
/**
 * The one address these fixtures both bind and dial. Passing it as `hostname`
 * matters: without it Node binds the IPv6 wildcard `::`, which coexists with a
 * foreign process already holding the more specific `127.0.0.1:<port>`, so the
 * drawn ephemeral port can be answered by that stranger instead of by byok.
 * Binding the address we dial turns a collision into a loud `EADDRINUSE`.
 */
const LOOPBACK = '127.0.0.1';

export interface RealServerHandle {
  byok: ByokServer;
  httpServer: HttpServer;
  url: string;
  /**
   * Mint a single-use pairing code for the SAME `productId` this server
   * instance was started with (S1). Bound to the handle rather than left to
   * each call site so a test can't accidentally pair a device into a product
   * its own `conn.hello` then contradicts — the kernel's hello gate compares
   * the announced product against this instance's `instanceProductId`.
   *
   * The tenant is no longer named here: an embedded server derives exactly one
   * tenant from its `productId` (`serverTenantId`, `packages/server/src/stores.ts`),
   * so `createPairingCode` takes the product alone — and is async, like every
   * other kernel-backed member of this surface.
   */
  createPairingCode(): Promise<PairingCodeInfo>;
  close(): Promise<void>;
}

/**
 * `Node.Server.close()` alone waits for every still-open connection to end
 * before its callback fires — including a long-poll `GET /byok/events` the
 * real server (by design) holds open for up to `longPollHoldMs` (~50s
 * default) waiting for events that, at test teardown time, are never
 * coming. `closeAllConnections()` (Node >=18.2) forcibly ends those so
 * teardown does not hang for the remainder of a long-poll hold — tests should
 * also pass a short `longPollHoldMs` themselves so any *mid-test* wait stays
 * short too, but this is the backstop for teardown regardless.
 */
function closeServer(httpServer: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    httpServer.close(() => resolve());
    httpServer.closeAllConnections?.();
  });
}

export async function startRealServer(opts: CreateByokServerOptions): Promise<RealServerHandle> {
  const byok = createByokServer(opts);
  return new Promise((resolve) => {
    const httpServer = serve({ fetch: byok.hono.fetch, port: 0, hostname: LOOPBACK }, (info) => {
      resolve({
        byok,
        httpServer: httpServer as HttpServer,
        url: `http://${LOOPBACK}:${info.port}`,
        createPairingCode: () => byok.pairing.createPairingCode({ productId: opts.productId }),
        close: async () => {
          // Releases the relay's per-task feeds and their reclamation timers
          // before the socket goes away, so nothing outlives the test file.
          await byok.close();
          await closeServer(httpServer as HttpServer);
        },
      });
    });
  });
}

/** Wait for `handle.events()` to produce an event matching `predicate` (mirrors `packages/server`'s own test-support helper, which isn't importable across the package boundary). */
export async function waitForTaskEvent(
  handle: TaskHandle,
  predicate: (event: ServerTaskEvent) => boolean,
): Promise<ServerTaskEvent> {
  for await (const event of handle.events()) {
    if (predicate(event)) return event;
  }
  throw new Error('task event stream ended before a matching event was seen');
}

/**
 * A `TaskHandle` for a running Agent task. Wire v4 `dispatch` only resumes an
 * Agent session, so this first runs one fresh execution of `agentRef`
 * through `executions.submit`, reads the session from its durable device
 * terminal, and dispatches the resume of that session. The seed has ended
 * when this returns; `session` is the resumed task's stub session.
 * `beforeResume` runs after the seed completed and before the resume.
 */
export async function dispatchResumedAgentTask(
  real: RealServerHandle,
  adapter: StubRuntimeAdapter,
  input: Omit<DispatchInput, 'sessionRef' | 'agentRef'> & { agentRef?: AgentRef },
  options: { beforeResume?: () => Promise<void> } = {},
): Promise<{ handle: TaskHandle; session: StubSession; sessionRef: string }> {
  const agentRef = input.agentRef ?? { agentId: `e2e-agent-${randomUUID()}`, profileRevision: 'rev-1' };
  // The seed runs on the same adapter the resume names, so the session handoff matches exactly.
  const target = input.harnessId !== undefined
    ? { harnessId: input.harnessId }
    : { runtime: input.runtime ?? (adapter.descriptor.id as RuntimeId) };
  const seedTaskId = `seed-${randomUUID()}`;
  const seedSessions = adapter.sessions.length;
  await vi.waitFor(async () => {
    expect(await real.byok.executions.submit({
      taskId: seedTaskId,
      deviceId: input.deviceId,
      payload: {
        instruction: 'seed the Agent session',
        ...target,
        agentRef,
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        terminalProjection: { mode: 'none' },
      },
    })).toMatchObject({ taskId: seedTaskId });
  }, { timeout: 5_000, interval: 20 });
  await vi.waitFor(() => expect(adapter.sessions.length).toBeGreaterThan(seedSessions), { timeout: 5_000 });
  adapter.sessions[seedSessions]!.emit({ type: 'turn_end' });
  const terminal = await vi.waitFor(async () => {
    const recorded = await real.byok.tasks.deviceTerminal(seedTaskId);
    if (recorded?.envelope.type !== 'task.complete') throw new Error('seed has no task.complete yet');
    return recorded.envelope;
  }, { timeout: 5_000, interval: 20 });
  const sessionRef = terminal.payload.sessionRef;
  if (sessionRef === undefined) throw new Error('seed task.complete carries no sessionRef');
  await vi.waitFor(async () => expect((await real.byok.tasks.get(seedTaskId))?.result).toMatchObject({ state: 'Complete' }), { timeout: 5_000, interval: 20 });

  await options.beforeResume?.();
  const resumedSessions = adapter.sessions.length;
  const handle = await real.byok.dispatch({ ...target, ...input, agentRef, sessionRef });
  await vi.waitFor(() => expect(adapter.sessions.length).toBeGreaterThan(resumedSessions), { timeout: 5_000 });
  return { handle, session: adapter.sessions[resumedSessions]!, sessionRef };
}
