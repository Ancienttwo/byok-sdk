import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { agentMemoryIntentOperationDigest } from '@byok-sdk/core';
import type {
  AgentMemoryIntentCompletion,
  AgentMemoryIntentOperation,
  AgentMemoryIntentReadback,
  AgentMemoryIntentV1,
  AgentRef,
} from '@byok-sdk/protocol';
import type { AgentMemoryIntentFetchInput } from '../../daemon/agent-memory-intent';
import { POWERCUT_DEVICE_ID, POWERCUT_TENANT_ID } from './protocol';
import { EMPTY_REVISION } from './snapshot';

/** What the Host issued, without the content (the content is a function of `seq`). */
export interface IssuedIntent {
  readonly seq: number;
  readonly intentId: string;
  readonly agentRef: AgentRef;
  readonly path: string;
  readonly operation: AgentMemoryIntentOperation;
  readonly baseRevision: string;
  readonly targetRevision: string | null;
  readonly operationDigest: string;
}

/**
 * The Host journal. The Host appends an entry BEFORE it answers the device,
 * so every entry is a fact the device had already been told, or had told the
 * Host, when the fault hit.
 *
 * - `receipt`: the first completion for an intent. The device sends complete
 *   only after its terminal barrier returned.
 * - `acked`: the processor resolved, which happens only after the `ackedAt`
 *   barrier returned.
 */
export type JournalEntry =
  | { readonly kind: 'issued'; readonly intent: IssuedIntent }
  | { readonly kind: 'receipt'; readonly intentId: string; readonly completion: AgentMemoryIntentCompletion }
  | { readonly kind: 'repeat'; readonly intentId: string; readonly disposition: 'idempotent' | 'conflict' }
  | { readonly kind: 'acked'; readonly intentId: string }
  | { readonly kind: 'failed'; readonly intentId: string; readonly reason: string }
  | { readonly kind: 'cut'; readonly round: number; readonly trigger: string };

/** In memory, and optionally appended to a file with an fsync per entry (a Host outside a VM). */
export class HostJournal {
  readonly entries: JournalEntry[] = [];
  readonly #fd: number | undefined;

  constructor(file?: string) {
    this.#fd = file === undefined ? undefined : openSync(file, 'a', 0o600);
  }

  append(entry: JournalEntry): void {
    this.entries.push(entry);
    if (this.#fd !== undefined) {
      writeSync(this.#fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(this.#fd);
    }
  }

  close(): void {
    if (this.#fd !== undefined) closeSync(this.#fd);
  }
}

const PATHS = ['MEMORY.md', 'notes/a.md', 'notes/b.md'] as const;
const MIN_CONTENT_BYTES = 40 * 1024;
const CONTENT_SPREAD_BYTES = 160 * 1024;

/**
 * Deterministic body of intent `seq`. It spans many 4 KiB clusters and stays
 * under the 256 KiB intent limit, so a torn or mixed write is a revision miss.
 */
export function powercutContent(seq: number): string {
  const size = MIN_CONTENT_BYTES + ((seq * 7919) % CONTENT_SPREAD_BYTES);
  const line = `w5 intent ${String(seq).padStart(8, '0')} memory line\n`;
  return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

export function contentRevision(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** Small deterministic generator so a seed reproduces the intent sequence. */
function unit(seed: number, seq: number): number {
  let value = (seed ^ Math.imul(seq + 1, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function stateRevision(completion: AgentMemoryIntentCompletion): string | undefined {
  switch (completion.outcome) {
    case 'applied': return completion.result.revision;
    case 'conflict':
    case 'uncertain': return completion.observed.revision;
    case 'rejected': return undefined;
  }
}

function sameCompletion(left: AgentMemoryIntentCompletion, right: AgentMemoryIntentCompletion): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface HostIntent {
  readonly issued: IssuedIntent;
  readonly intent: AgentMemoryIntentV1;
  stored?: AgentMemoryIntentCompletion;
  acked: boolean;
}

export interface PowercutHostOptions {
  readonly seed: number;
  /** A new Agent home every N intents, so the run keeps creating homes. Far below the 511-record ledger. */
  readonly intentsPerHome: number;
  readonly journal: HostJournal;
}

/**
 * The independent Host. It approves intents one at a time, stores the first
 * completion of each, and answers a repeat as `idempotent` or `conflict`
 * exactly as a strict Host would. Its view of each file comes only from
 * stored completions.
 */
export class PowercutHost {
  readonly journal: HostJournal;
  readonly #seed: number;
  readonly #intentsPerHome: number;
  readonly #intents = new Map<string, HostIntent>();
  readonly #order: string[] = [];
  readonly #revisions = new Map<string, string>();

  constructor(options: PowercutHostOptions) {
    if (!Number.isInteger(options.intentsPerHome) || options.intentsPerHome < 1 || options.intentsPerHome > 64) {
      throw new Error('intentsPerHome must be an integer in 1..64');
    }
    this.#seed = options.seed;
    this.#intentsPerHome = options.intentsPerHome;
    this.journal = options.journal;
  }

  /** Intents without an ack, in issue order. After a restart the Host redelivers them. */
  pending(): readonly IssuedIntent[] {
    return this.#order.map((id) => this.#intents.get(id)!).filter((entry) => !entry.acked).map((entry) => entry.issued);
  }

  issuedCount(): number {
    return this.#order.length;
  }

  async issueNext(): Promise<IssuedIntent> {
    const seq = this.#order.length;
    const agentRef = { agentId: `w5-agent-${Math.floor(seq / this.#intentsPerHome)}`, profileRevision: '1' };
    const path = PATHS[Math.floor(unit(this.#seed, seq) * PATHS.length)]!;
    const baseRevision = this.#revisions.get(`${agentRef.agentId}\0${path}`) ?? EMPTY_REVISION;
    const remove = path !== 'MEMORY.md' && baseRevision !== EMPTY_REVISION && unit(this.#seed + 1, seq) < 0.35;
    const operation: AgentMemoryIntentOperation = remove ? 'delete' : 'replace';
    const content = remove ? undefined : powercutContent(seq);
    const targetRevision = content === undefined ? null : contentRevision(content);
    const intentId = randomUUID();
    const approvalRef = `approval:w5-${seq}`;
    const operationDigest = await agentMemoryIntentOperationDigest({
      tenantId: POWERCUT_TENANT_ID, deviceId: POWERCUT_DEVICE_ID, intentId, agentRef, path, operation, baseRevision, targetRevision, approvalRef,
    });
    const intent: AgentMemoryIntentV1 = {
      intentId, agentRef, path, operation, baseRevision, targetRevision,
      ...(content === undefined ? {} : { content }), approvalRef, operationDigest,
    };
    const issued: IssuedIntent = { seq, intentId, agentRef, path, operation, baseRevision, targetRevision, operationDigest };
    this.journal.append({ kind: 'issued', intent: issued });
    this.#intents.set(intentId, { issued, intent, acked: false });
    this.#order.push(intentId);
    return issued;
  }

  fetch(request: AgentMemoryIntentFetchInput): unknown {
    const entry = this.#intents.get(request.intentId);
    if (entry === undefined) throw new Error(`fetch for an intent the Host never issued: ${request.intentId}`);
    // A home holds at most 64 intents here, so the ledger never runs out of slots.
    if (request.reservation !== 'held') throw new Error(`fetch without a reserved ledger slot: ${request.intentId}`);
    // The Host cannot know whether a lost release was consumed. Until a
    // completion is stored it releases the same immutable intent again.
    return { disposition: 'release', intent: entry.intent };
  }

  complete(completion: AgentMemoryIntentCompletion): AgentMemoryIntentReadback {
    const entry = this.#intents.get(completion.intentId);
    if (entry === undefined) throw new Error(`complete for an intent the Host never issued: ${completion.intentId}`);
    let disposition: AgentMemoryIntentReadback['disposition'];
    if (entry.stored === undefined) {
      this.journal.append({ kind: 'receipt', intentId: completion.intentId, completion });
      entry.stored = completion;
      const revision = stateRevision(completion);
      if (revision !== undefined) this.#revisions.set(`${entry.issued.agentRef.agentId}\0${entry.issued.path}`, revision);
      disposition = 'recorded';
    } else {
      disposition = sameCompletion(entry.stored, completion) ? 'idempotent' : 'conflict';
      this.journal.append({ kind: 'repeat', intentId: completion.intentId, disposition });
    }
    return {
      tenantId: POWERCUT_TENANT_ID,
      deviceId: POWERCUT_DEVICE_ID,
      intentId: completion.intentId,
      disposition,
      completion: entry.stored,
      recordedAt: new Date().toISOString(),
    };
  }

  acked(intentId: string): void {
    const entry = this.#intents.get(intentId);
    if (entry === undefined) throw new Error(`ack for an intent the Host never issued: ${intentId}`);
    entry.acked = true;
    this.journal.append({ kind: 'acked', intentId });
  }

  failed(intentId: string, reason: string): void {
    this.journal.append({ kind: 'failed', intentId, reason });
  }
}
