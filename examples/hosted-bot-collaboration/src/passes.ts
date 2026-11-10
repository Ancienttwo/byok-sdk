import type { Pool } from 'pg';
import type { FrozenSubmitPort } from '@byok-sdk/server/execution-core';
import { HostedDeviceObserver, type DeviceObserverOptions, type HostedDevicePort } from './devices';
import { HostedDueScheduler, type DueSchedulerOptions } from './due';
import { HostedSubmitter, type SubmitterOptions } from './intents';
import { HostedReconciler, type HostedTaskPort, type ReconcilerOptions } from './reconcile';
import { HostedReplyChecker, type HostedReplyPort, type ReplyCheckerOptions } from './replies';
import { HostedRoutineScheduler, type SchedulerOptions } from './scheduler';
import { HostedOutboxSender, type CardConnector, type HostedHomePort, type ProjectionPort, type SendFailure, type SenderOptions } from './sender';
import type { HostedCollaborationStore, HostedSyncOptions, SyncResult } from './store';
import type { ChannelPort } from '@byok-sdk/example-bot-collaboration/channel';

/** Pass options that the deployment tunes. Each is the pass's own option type without the fields that `HostedPasses` wires. */
export interface HostedPassTimings {
  routines?: Omit<SchedulerOptions, 'intervalMs' | 'changed'>;
  submitter?: Omit<SubmitterOptions, 'port' | 'changed'>;
  reconciler?: Omit<ReconcilerOptions, 'port' | 'changed'>;
  due?: Omit<DueSchedulerOptions, 'sync'>;
  replies?: Omit<ReplyCheckerOptions, 'port'>;
  devices?: Omit<DeviceObserverOptions, 'port'>;
  sender?: Omit<SenderOptions, 'projections' | 'channel' | 'connector' | 'homes' | 'changed'>;
}

/** The ports of one Host. Each required port is a pass's input, so a deployment cannot leave a pass without it. */
export interface HostedPassPorts {
  /** The SDK calls of the tenant that owns `scope`: the submitter and the reconciler read and write through them. */
  task: (scope: string) => FrozenSubmitPort & HostedTaskPort;
  replies: (scope: string) => HostedReplyPort;
  devices: (scope: string) => HostedDevicePort;
  projections: ProjectionPort;
  homes: (scope: string) => HostedHomePort;
  /** The sync options of every scope, without the clock that `HostedPasses` reads. */
  sync: Omit<HostedSyncOptions, 'now'>;
  /** How often the deployment calls `run()`. The routine scheduler checks it against the K8 late bound. */
  intervalMs: number;
  /** The channel of the K8 deliveries. Absent: the Host has no channel, and a delivery row fails. */
  channel?: ChannelPort;
  /** The connector of the confirmed cards. Absent: the Host has no connector, and a card row fails. */
  connector?: CardConnector;
  timings?: HostedPassTimings;
}

export interface PassSynced { scope: string; error?: string }
export interface PassFailure { scope: string; id?: string; error: string }
export interface PassReport {
  routineStart: PassFailure[];
  routines: { fired: number; fenced: PassFailure[]; failed: PassFailure[] };
  reconcile: { concluded: number; failed: PassFailure[] };
  synced: PassSynced[];
  due: { synced: number; stalled: string[]; failed: PassFailure[] };
  /** `synced`: the scopes of the intents that the submitter concluded with no SDK call, synced after it. */
  submit: { tried: number; failed: PassFailure[]; synced: PassSynced[] };
  /** The outbox sender: `failed` lists the rows it could not send, a card or delivery row (no port) among them; `synced`: the scopes it changed. */
  send: { steps: number; failed: PassFailure[]; synced: PassSynced[] };
}

const text = (error: unknown): string => error instanceof Error ? error.message : String(error);
function failures(list: readonly { scope: string; error: unknown; routineId?: string; turnId?: string }[]): PassFailure[] {
  return list.map(item => ({ scope: item.scope, ...(item.routineId || item.turnId ? { id: item.routineId || item.turnId } : {}), error: text(item.error) }));
}
const sendFailures = (list: readonly SendFailure[]): PassFailure[] =>
  list.map(item => ({ scope: item.scope, id: typeof item.id === 'string' ? item.id : JSON.stringify(item.id), error: text(item.error) }));

/**
 * The passes of one hosted Host, in their one order. The deployment builds one `HostedPasses`, calls `run()` every
 * `intervalMs`, and gives `syncScope` to the command entry's `sync`. Every pass port is required here, so a Host cannot
 * leave one out.
 */
export class HostedPasses {
  private readonly checker: HostedReplyChecker;
  private readonly devices: HostedDeviceObserver;

  constructor(private readonly pool: Pool, private readonly store: HostedCollaborationStore, private readonly ports: HostedPassPorts) {
    this.checker = new HostedReplyChecker(store, { ...ports.timings?.replies, port: ports.replies });
    this.devices = new HostedDeviceObserver(store, { ...ports.timings?.devices, port: ports.devices });
  }

  /** The composed sync of one scope: the reply checks, the device readiness, then the store's sync. Each commits on its own. */
  readonly syncScope = async (scope: string, now: number): Promise<SyncResult> => {
    await this.checker.check(scope, now);
    await this.devices.observe(scope);
    return this.store.sync(scope, { ...this.ports.sync, now });
  };

  /** One pass of every H pass, each in its own instance. A scope whose sync fails goes into the report; the pass goes on. */
  async run(): Promise<PassReport> {
    const { pool, store, ports } = this, timings = ports.timings ?? {};
    const changed = new Set<string>(), concluded = new Set<string>(), sentChanged = new Set<string>();
    const sender = new HostedOutboxSender(pool, store, { ...timings.sender, projections: ports.projections, homes: ports.homes,
      ...(ports.channel ? { channel: ports.channel } : {}), ...(ports.connector ? { connector: ports.connector } : {}),
      changed: scope => { sentChanged.add(scope); } });
    const routines = new HostedRoutineScheduler(pool, store, { ...timings.routines, intervalMs: ports.intervalMs, changed: scope => { changed.add(scope); } });
    const submitter = new HostedSubmitter(pool, store.schema, { ...timings.submitter, port: ports.task, changed: scope => { concluded.add(scope); } });
    const reconciler = new HostedReconciler(pool, store.schema, store, { ...timings.reconciler, port: ports.task, changed: scope => { changed.add(scope); } });
    const due = new HostedDueScheduler(pool, store, { ...timings.due, sync: this.syncScope });
    const syncAll = async (scopes: Iterable<string>) => {
      const synced: PassSynced[] = [];
      for (const scope of scopes) {
        try { await this.syncScope(scope, Date.now()); synced.push({ scope }); } catch (error) { synced.push({ scope, error: text(error) }); }
      }
      return synced;
    };
    // `start()` is K4 `recover`: it reads the routine rows, so it is safe on every pass, and a Worker has no process start.
    const routineStart = failures(await routines.start());
    const routinePass = await routines.run();
    const reconcile = await reconciler.run();
    const synced = await syncAll(changed);
    const duePass = await due.run();
    // Last of these, so a Turn that this pass froze is offered in the same pass. An intent that the submitter concluded with no
    // SDK call (the queued expiry, or a sealed row with no sealed lane) has its scope synced after it, so its Turn settles too.
    const submit = await submitter.run();
    const submitSynced = await syncAll(concluded);
    // After the submitter: a Bot's home step makes it ready, and its next Turn freezes in the sync that follows.
    const sent = await sender.run();
    const sendSynced = await syncAll(sentChanged);
    return { routineStart, routines: { fired: routinePass.fired, fenced: failures(routinePass.fenced), failed: failures(routinePass.failed) },
      reconcile: { concluded: reconcile.concluded, failed: failures(reconcile.failed) }, synced,
      due: { synced: duePass.synced, stalled: duePass.stalled, failed: failures(duePass.failed) },
      submit: { tried: submit.tried, failed: failures(submit.failed), synced: submitSynced },
      send: { steps: sent.steps, failed: sendFailures(sent.failed), synced: sendSynced } };
  }

  /**
   * The command entry's `failStuckIntent` (#955): the reconciler's owner settle for `scope`, then the scope's sync, also when the
   * call refuses. When both fail, the error carries both, the sync's first.
   */
  async failStuckIntent(scope: string, key: string): Promise<void> {
    const touched = new Set<string>();
    const reconciler = new HostedReconciler(this.pool, this.store.schema, this.store,
      { ...this.ports.timings?.reconciler, port: this.ports.task, changed: changed => { touched.add(changed); } });
    let callError: unknown, failed = false;
    try { await reconciler.failStuckIntent(scope, key); } catch (error) { callError = error; failed = true; }
    try { for (const changed of touched) await this.syncScope(changed, Date.now()); }
    catch (syncError) {
      if (failed) throw new AggregateError([syncError, callError], text(syncError));
      throw syncError;
    }
    if (failed) throw callError;
  }
}
