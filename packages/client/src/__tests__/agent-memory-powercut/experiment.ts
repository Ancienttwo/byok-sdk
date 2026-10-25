import { checkCut, checkRecovery, type CutCheck, type CutWindow, type InvariantResult } from './checker';
import type { DeviceRun, FaultKind, PowerCutDriver, StorageProfile } from './drivers';
import type { IssuedIntent, PowercutHost } from './host';
import { readMessages, writeMessage, type DeviceMessage } from './protocol';
import type { DeviceSnapshot } from './snapshot';

/**
 * When to cut, counted from the start of a round's new intents (1-based).
 * A Host point stops answering at that message, so it lands only between
 * barriers: `fetch` before `applying`, `complete` after the terminal barrier,
 * `acked` after the `ackedAt` barrier. Only a delay can land inside a write
 * (temp, flush, rename, directory flush).
 */
export type CutTrigger =
  | { readonly kind: 'host'; readonly on: 'fetch' | 'complete' | 'acked'; readonly intent: number }
  | { readonly kind: 'delay'; readonly ms: number };

export function describeTrigger(trigger: CutTrigger): string {
  return trigger.kind === 'host' ? `host:${trigger.on}@${trigger.intent}` : `delay:${trigger.ms}ms`;
}

export interface CutReport extends CutCheck {
  readonly round: number;
  readonly trigger: string;
  readonly intentsBeforeCut: number;
  readonly recovery: InvariantResult | undefined;
}

export interface ExperimentReport {
  readonly fault: FaultKind;
  readonly storageProfile: StorageProfile;
  /** What these cuts can stand for. Power loss without a dropping storage layer is only OS-crash evidence. */
  readonly evidence: FaultKind;
  readonly device: Omit<DeviceSnapshot, 'homes'> | undefined;
  readonly cuts: readonly CutReport[];
  readonly windows: Readonly<Partial<Record<CutWindow, number>>>;
  readonly violations: number;
  readonly stoppedEarly: string | undefined;
}

type Waiter = (outcome: 'acked' | 'failed' | 'closed') => void;

/** The Host end of one device run. */
class HostSession {
  readonly snapshot: Promise<DeviceSnapshot>;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  #armed: { readonly on: 'fetch' | 'complete' | 'acked'; readonly intentId: string; fire(): void } | undefined;
  #waiter: { readonly intentId: string; readonly resolve: Waiter } | undefined;
  #ended = false;

  constructor(private readonly run: DeviceRun, private readonly host: PowercutHost) {
    let snapshot!: (value: DeviceSnapshot) => void;
    let ready!: () => void;
    this.snapshot = new Promise((resolve) => { snapshot = resolve; });
    this.ready = new Promise((resolve) => { ready = resolve; });
    // A cut can land while the Host writes. That message is lost, as at a
    // real power cut; the Host acts on the end of the device's input instead.
    run.link.output.on('error', () => {});
    this.closed = (async () => {
      for await (const message of readMessages<DeviceMessage>(run.link.input)) {
        switch (message.type) {
          case 'snapshot': snapshot(message.snapshot); break;
          case 'ready': ready(); break;
          case 'fetch': this.#answer(message.id, message.request.intentId, 'fetch', () => this.host.fetch(message.request)); break;
          case 'complete': this.#answer(message.id, message.completion.intentId, 'complete', () => this.host.complete(message.completion)); break;
          case 'acked':
            this.host.acked(message.intentId);
            if (!this.#fire('acked', message.intentId)) this.#settle(message.intentId, 'acked');
            break;
          case 'failed':
            this.host.failed(message.intentId, message.reason);
            this.#settle(message.intentId, 'failed');
            break;
        }
      }
      this.#ended = true;
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter?.resolve('closed');
    })();
  }

  /** Arm one Host point. It fires instead of the answer; the run then waits for the cut. */
  arm(on: 'fetch' | 'complete' | 'acked', intentId: string, fire: () => void): void {
    this.#armed = { on, intentId, fire };
  }

  /** Deliver one notice and wait until the device acknowledged it, failed it, or went away. */
  deliver(intent: IssuedIntent): Promise<'acked' | 'failed' | 'closed'> {
    // Nothing settles a waiter once the device's input has ended.
    if (this.#ended) return Promise.resolve('closed');
    return new Promise((resolve) => {
      this.#waiter = { intentId: intent.intentId, resolve };
      writeMessage(this.run.link.output, { type: 'notice', payload: { intentId: intent.intentId, agentRef: intent.agentRef } });
    });
  }

  stop(): void {
    writeMessage(this.run.link.output, { type: 'stop' });
  }

  #answer(id: number, intentId: string, on: 'fetch' | 'complete', answer: () => unknown): void {
    let value: unknown;
    try {
      value = answer();
    } catch {
      writeMessage(this.run.link.output, { type: 'reply', id, ok: false });
      return;
    }
    // The Host has already journaled a completion here; only its reply is withheld.
    if (this.#fire(on, intentId)) return;
    writeMessage(this.run.link.output, { type: 'reply', id, ok: true, value });
  }

  #fire(on: 'fetch' | 'complete' | 'acked', intentId: string): boolean {
    const armed = this.#armed;
    if (armed === undefined || armed.on !== on || armed.intentId !== intentId) return false;
    this.#armed = undefined;
    armed.fire();
    return true;
  }

  #settle(intentId: string, outcome: 'acked' | 'failed'): void {
    if (this.#waiter?.intentId !== intentId) return;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter.resolve(outcome);
  }
}

export interface ExperimentOptions {
  readonly driver: PowerCutDriver;
  readonly host: PowercutHost;
  /** One cut per trigger, then a final restart that is checked and stopped cleanly. */
  readonly triggers: readonly CutTrigger[];
  /** A round that reaches this many new intents without a cut fails the run. */
  readonly maxIntentsPerRound?: number;
}

/**
 * Each round: start the device, check its snapshot against the journal up
 * to the last cut, redeliver every open intent (I6), then issue new intents
 * until the trigger cuts the device. A failed notice ends the experiment:
 * an intent that cannot settle blocks every later round.
 */
export async function runExperiment(options: ExperimentOptions): Promise<ExperimentReport> {
  const { driver, host, triggers } = options;
  const maxIntents = options.maxIntentsPerRound ?? 200;
  const journal = host.journal;
  const cuts: CutReport[] = [];
  let device: ExperimentReport['device'];
  let stoppedEarly: string | undefined;
  let lastCut: { round: number; trigger: string; journalLength: number; intentsBeforeCut: number } | undefined;

  for (let round = 0; round <= triggers.length; round += 1) {
    const run = await driver.start();
    const session = new HostSession(run, host);
    const snapshot = await session.snapshot;
    const { homes: _homes, ...facts } = snapshot;
    device ??= facts;
    const check = lastCut === undefined ? undefined : checkCut(snapshot, journal.entries.slice(0, lastCut.journalLength));
    await session.ready;
    const open = host.pending();
    const recoveryStart = journal.entries.length;
    let failed = false;
    for (const intent of open) {
      const outcome = await session.deliver(intent);
      if (outcome !== 'acked') {
        failed = true;
        break;
      }
    }
    if (lastCut !== undefined && check !== undefined) {
      cuts.push({ ...lastCut, ...check, recovery: checkRecovery(open, journal.entries.slice(recoveryStart)) });
    }
    if (failed) {
      stoppedEarly = `recovery after round ${round - 1} did not settle every open intent`;
      await driver.cut();
      break;
    }
    if (round === triggers.length) {
      session.stop();
      await driver.stop();
      break;
    }

    const trigger = triggers[round]!;
    let cutting: Promise<void> | undefined;
    const cut = (): void => { cutting ??= driver.cut(); };
    const timer = trigger.kind === 'delay' ? setTimeout(cut, trigger.ms) : undefined;
    let issued = 0;
    for (;;) {
      if (cutting !== undefined) break;
      if (issued >= maxIntents) {
        clearTimeout(timer);
        cut();
        stoppedEarly = `round ${round} reached ${maxIntents} intents without a cut`;
        break;
      }
      const intent = await host.issueNext();
      issued += 1;
      // A delay cut can fire while the intent is being issued.
      if (cutting !== undefined) break;
      if (trigger.kind === 'host' && trigger.intent === issued) session.arm(trigger.on, intent.intentId, cut);
      const outcome = await session.deliver(intent);
      if (outcome === 'failed') {
        clearTimeout(timer);
        cut();
        stoppedEarly = `round ${round}: a notice failed before any cut`;
        break;
      }
      if (outcome === 'closed') break;
    }
    await cutting;
    await run.ended;
    await session.closed;
    journal.append({ kind: 'cut', round, trigger: describeTrigger(trigger) });
    lastCut = { round, trigger: describeTrigger(trigger), journalLength: journal.entries.length, intentsBeforeCut: issued };
    if (stoppedEarly !== undefined) break;
  }

  const windows: Partial<Record<CutWindow, number>> = {};
  for (const report of cuts) windows[report.window] = (windows[report.window] ?? 0) + 1;
  const violations = cuts.reduce((count, report) =>
    count + [...report.invariants, ...(report.recovery === undefined ? [] : [report.recovery])].filter((entry) => entry.status === 'violated').length, 0);
  return {
    fault: driver.fault,
    storageProfile: driver.storageProfile,
    evidence: driver.fault === 'power-loss' && !driver.storageProfile.dropsUnflushedWrites ? 'os-crash' : driver.fault,
    device,
    cuts,
    windows,
    violations,
    stoppedEarly,
  };
}
