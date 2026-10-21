import { promises as fs } from 'node:fs';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import type { Session, PolicyUnsupportedError, SteerUnsupportedError } from '../../types';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import type { RuntimeExecutionFailure, RuntimeDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import type { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import type { AcpConnection, AcpMethodNotFound, AcpRpcError } from './acp-connection';
import type { identifyHermesGateway } from './gateway-identity';
import type { removeHermesProfile } from './hermes-home';
import { AsyncQueue } from '../../util/async-queue';
import { HermesProjection } from './projection';

/** Runtime identities are owned by the calling entry, never copied into this lazy bundle. */
export interface HermesSessionDependencies {
  AcpConnection: typeof AcpConnection;
  AcpMethodNotFound: typeof AcpMethodNotFound;
  AcpRpcError: typeof AcpRpcError;
  RuntimeExecutionFailure: typeof RuntimeExecutionFailure;
  RuntimeDisposalFailure: typeof RuntimeDisposalFailure;
  PolicyUnsupportedError: typeof PolicyUnsupportedError;
  SteerUnsupportedError: typeof SteerUnsupportedError;
  isRuntimeExecutionFailure: typeof isRuntimeExecutionFailure;
  infrastructure: (phase: 'start' | 'run', reason: string, retry?: 'retryable' | 'non-retryable') => RuntimeExecutionFailure;
  identifyHermesGateway: typeof identifyHermesGateway;
  removeHermesProfile: typeof removeHermesProfile;
}
export interface HermesSessionHandle extends Session {
  ownHome(home: string): void;
  assertOpen(): void;
  ownGateway(gateway: OwnedLineProcess): void;
  ownViewer(viewer: OwnedLineProcess): AcpConnection;
  awaitGatewayReady(home: string, pid: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<void>;
  ready(sessionId: string): void;
  prompt(text: string): void;
}
const GATEWAY_POLL_MS = 100;
export function createHermesSession(scratch: ExecutionScratch, root: string, liveHomes: Set<string>, interruptMs: number, dependencies: HermesSessionDependencies): HermesSessionHandle {
  const { AcpConnection, AcpMethodNotFound, AcpRpcError, RuntimeExecutionFailure, RuntimeDisposalFailure,
    PolicyUnsupportedError, SteerUnsupportedError, isRuntimeExecutionFailure, infrastructure,
    identifyHermesGateway, removeHermesProfile } = dependencies;

  class HermesSession implements Session {
    sessionRef = '';
    private home?: string;
    private gateway?: OwnedLineProcess;
    private viewer?: OwnedLineProcess;
    private connection?: AcpConnection;
    private readonly projection = new HermesProjection();
    private readonly queue = new AsyncQueue<AgentEvent>();
    private failure?: RuntimeExecutionFailure;
    private turn?: Promise<void>;
    private stopping = false;
    private closeAttempt?: Promise<void>;

    constructor(
      private readonly scratch: ExecutionScratch,
      private readonly root: string,
      private readonly liveHomes: Set<string>,
      private readonly interruptMs: number,
    ) {}

    ownHome(home: string): void {
      this.home = home;
      this.liveHomes.add(home);
    }

    assertOpen(): void {
      if (this.stopping) throw this.failure ?? infrastructure('start', 'hermes session closed during start');
    }

    ownGateway(gateway: OwnedLineProcess): void {
      this.gateway = gateway;
      // The gateway's stdout is a banner, not a protocol. Drain it.
      gateway.onLine(() => {});
      void gateway.exited.then(() => this.exited('gateway'), (error) => this.fail(error));
    }

    ownViewer(viewer: OwnedLineProcess): AcpConnection {
      this.viewer = viewer;
      this.connection = new AcpConnection(viewer, {
        notification: (method, params) => {
          if (method !== 'session/update' || params.sessionId !== this.sessionRef) return;
          const update = params.update;
          if (update !== null && typeof update === 'object' && !Array.isArray(update)) {
            this.projection.update(update as Record<string, unknown>, (event) => this.queue.push(event));
          }
        },
        request: (method) => {
          // Edits run in `dont_ask` mode and commands under `--yolo`. What still
          // asks is Hermes's own guard (sensitive paths). No human can answer,
          // so the guard stands: the request is cancelled, never allowed.
          if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
          throw new AcpMethodNotFound(method);
        },
      });
      void viewer.exited.then(() => this.exited('acp viewer'), (error) => this.fail(error));
      return this.connection;
    }

    /** Waits until the gateway serving `home` is the owned process and reports ready. */
    async awaitGatewayReady(home: string, pid: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
      const served = await fs.realpath(home);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (this.failure) throw this.failure;
        if (signal?.aborted) throw infrastructure('start', 'hermes start was aborted', 'retryable');
        const identity = await identifyHermesGateway(home);
        if (identity !== undefined) {
          if (identity.pid !== pid) throw infrastructure('start', 'another Hermes gateway serves the execution profile');
          if (identity.state === 'ready' && identity.servedHomes.includes(served)) return;
        }
        if (Date.now() >= deadline) throw infrastructure('start', 'hermes gateway did not report ready in time', 'retryable');
        await new Promise((resolve) => setTimeout(resolve, GATEWAY_POLL_MS));
      }
    }

    ready(sessionId: string): void {
      this.sessionRef = sessionId;
    }

    /** Sends one `session/prompt`. Its answer, not the send, ends the turn. */
    prompt(text: string): void {
      if (!this.connection || !this.sessionRef) throw infrastructure('run', 'hermes session is not open');
      if (this.turn) throw infrastructure('run', 'hermes turn is already active');
      const turn = this.connection.request('session/prompt', { sessionId: this.sessionRef, prompt: [{ type: 'text', text }] }).then(
        (result) => this.projection.turnEnded(result, (event) => this.queue.push(event)),
        (error) => {
          // close() rejects the pending prompt on purpose; that is not a turn failure.
          if (this.stopping) return;
          this.fail(error instanceof AcpRpcError && error.details === 'admitted_turn_failed'
            ? new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: 'hermes turn failed' })
            : error);
        },
      ).finally(() => {
        if (this.turn === turn) this.turn = undefined;
      });
      this.turn = turn;
    }

    get events(): AsyncIterable<AgentEvent> {
      const self = this;
      return (async function* () {
        try {
          for await (const event of self.queue) yield event;
        } catch (error) {
          self.fail(error);
          throw self.failure;
        }
        if (self.failure) throw self.failure;
      })();
    }

    async followUp(task: TaskOfferPayload): Promise<void> {
      if (typeof task.instruction !== 'string') throw new PolicyUnsupportedError('hermes requires a string instruction');
      if (task.dispatchSelection !== undefined) throw new PolicyUnsupportedError('hermes does not accept a dispatch selection');
      this.prompt(task.instruction);
    }

    async steer(): Promise<void> {
      throw new SteerUnsupportedError('hermes', 'hermes adapter does not support mid-turn steering');
    }

    async interrupt(): Promise<void> {
      const turn = this.turn;
      if (!this.connection || !turn) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.connection.notify('session/cancel', { sessionId: this.sessionRef });
        await Promise.race([
          turn,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(infrastructure('run', 'hermes cancel timed out')), this.interruptMs);
          }),
        ]);
      } catch (error) {
        this.fail(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    async resolveApproval(): Promise<void> {
      throw new PolicyUnsupportedError('Hermes has no interactive approval product lane');
    }

    fail(error: unknown): void {
      this.failure ??= isRuntimeExecutionFailure(error)
        ? error
        : infrastructure('run', error instanceof Error ? error.message : 'hermes runtime failed');
      this.queue.end();
      void this.close().catch(() => {});
    }

    private exited(which: string): void {
      if (!this.stopping) this.fail(infrastructure('run', `hermes ${which} exited`));
    }

    async close(): Promise<void> {
      this.stopping = true;
      if (!this.closeAttempt) {
        const attempt = (async () => {
          try {
            this.connection?.close(infrastructure('run', 'hermes session closed'));
            try {
              try {
                await this.viewer?.dispose();
              } finally {
                await this.gateway?.dispose();
              }
            } finally {
              if (this.home !== undefined) {
                await removeHermesProfile(this.root, this.home).catch((cause: unknown) => {
                  throw new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'hermes execution profile removal did not complete' }, { cause });
                });
                this.liveHomes.delete(this.home);
              }
              await this.scratch.release();
            }
          } finally {
            this.queue.end();
          }
          this.connection = undefined;
          this.viewer = undefined;
          this.gateway = undefined;
          this.home = undefined;
        })();
        this.closeAttempt = attempt.catch((error) => {
          this.closeAttempt = undefined;
          throw error;
        });
      }
      await this.closeAttempt;
    }
  }

  return new HermesSession(scratch, root, liveHomes, interruptMs);
}

type OwnedLineProcess = ReturnType<ReturnType<typeof createOwnedLineProcessSpawn>>;
