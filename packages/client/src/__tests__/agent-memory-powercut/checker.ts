import type { AgentMemoryIntentCompletion } from '@byok-sdk/protocol';
import {
  parseAgentMemoryIntentLedger,
  type AgentMemoryIntentLedgerRecord,
} from '../../daemon/agent-memory-intent';
import type { IssuedIntent, JournalEntry } from './host';
import { EMPTY_REVISION, type DeviceSnapshot, type HomeSnapshot } from './snapshot';

export const INVARIANTS = {
  I1: 'Each ledger parses with the real strict parser, holds only issued intents, and has at most its last record open',
  I2: 'Every completion the Host received is a durable device terminal with the same outcome',
  I3: 'Every intent the Host saw acknowledged has a durable ackedAt',
  I4: 'Each memory file is a state the ledger order allows',
  I5: 'Each memory file is empty or a complete body the Host issued for that path',
  I6: 'After the restart, every open intent is acknowledged with the stored completion',
} as const;
export type InvariantId = keyof typeof INVARIANTS;

export interface InvariantResult {
  readonly id: InvariantId;
  readonly status: 'held' | 'violated';
  readonly details: readonly string[];
}

/** Where the last issued intent stood on the device when the fault hit. An observation, not an invariant. */
export type CutWindow =
  | 'no-intent'
  | 'no-record'
  | 'applying'
  | 'terminal-without-receipt'
  | 'receipt-without-ack'
  | 'acked';

export interface CutCheck {
  readonly invariants: readonly InvariantResult[];
  readonly window: CutWindow;
  readonly leftovers: number;
  readonly leaseMarkers: number;
}

interface Facts {
  readonly issued: ReadonlyMap<string, IssuedIntent>;
  readonly receipts: ReadonlyMap<string, AgentMemoryIntentCompletion>;
  readonly acked: ReadonlySet<string>;
}

function facts(journal: readonly JournalEntry[]): Facts {
  const issued = new Map<string, IssuedIntent>();
  const receipts = new Map<string, AgentMemoryIntentCompletion>();
  const acked = new Set<string>();
  for (const entry of journal) {
    if (entry.kind === 'issued') issued.set(entry.intent.intentId, entry.intent);
    else if (entry.kind === 'receipt') receipts.set(entry.intentId, entry.completion);
    else if (entry.kind === 'acked') acked.add(entry.intentId);
  }
  return { issued, receipts, acked };
}

/** The outcome part of a completion, which the device derives from its terminal record. */
function outcomeOf(completion: AgentMemoryIntentCompletion): string {
  switch (completion.outcome) {
    case 'applied': return JSON.stringify(['applied', completion.result.exists, completion.result.revision]);
    case 'conflict': return JSON.stringify(['conflict', completion.observed.exists, completion.observed.revision]);
    case 'uncertain': return JSON.stringify(['uncertain', completion.observed.exists, completion.observed.revision]);
    case 'rejected': return JSON.stringify(['rejected', completion.code]);
  }
}

function recordOutcome(record: AgentMemoryIntentLedgerRecord): string | undefined {
  const detail = record.detail;
  if (record.state === 'applying' || detail === null) return undefined;
  if ('code' in detail) return JSON.stringify(['rejected', detail.code]);
  return JSON.stringify([record.state, detail.exists, detail.revision]);
}

function decodeLedger(home: HomeSnapshot): { records: readonly AgentMemoryIntentLedgerRecord[] } | { error: string } | undefined {
  if (home.ledgerBase64 === null) return undefined;
  const bytes = Buffer.from(home.ledgerBase64, 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { error: `${home.agentId}: ledger is not UTF-8 (${bytes.byteLength} bytes)` };
  }
  try {
    return { records: parseAgentMemoryIntentLedger(text) };
  } catch {
    return { error: `${home.agentId}: strict parser refused the ledger (${bytes.byteLength} bytes)` };
  }
}

interface MemoryState {
  readonly exists: boolean;
  readonly revision: string;
}

function result(id: InvariantId, details: string[]): InvariantResult {
  return { id, status: details.length === 0 ? 'held' : 'violated', details };
}

/**
 * Check one cut: the device snapshot taken after the restart against the
 * Host journal up to the cut. A home whose ledger fails I1 cannot be read;
 * I2 to I4 then report that home as a violation instead of skipping it.
 */
export function checkCut(snapshot: DeviceSnapshot, journal: readonly JournalEntry[]): CutCheck {
  const { issued, receipts, acked } = facts(journal);
  const homes = new Map(snapshot.homes.map((home) => [home.agentId, home]));
  const ledgers = new Map<string, readonly AgentMemoryIntentLedgerRecord[]>();
  const i1: string[] = [];
  for (const home of snapshot.homes) {
    const decoded = decodeLedger(home);
    if (decoded === undefined) continue;
    if ('error' in decoded) {
      i1.push(decoded.error);
      continue;
    }
    ledgers.set(home.agentId, decoded.records);
    decoded.records.forEach((record, index) => {
      const intent = issued.get(record.intentId);
      if (intent === undefined || intent.agentRef.agentId !== home.agentId || intent.path !== record.path
        || intent.operation !== record.operation || intent.operationDigest !== record.operationDigest) {
        i1.push(`${home.agentId}: record ${record.intentId} is not an intent the Host issued for this home`);
      }
      if (record.state === 'applying' && index !== decoded.records.length - 1) {
        i1.push(`${home.agentId}: record ${record.intentId} is applying but is not the last record`);
      }
    });
  }

  const recordFor = (intentId: string): AgentMemoryIntentLedgerRecord | undefined => {
    const intent = issued.get(intentId);
    return intent === undefined ? undefined : ledgers.get(intent.agentRef.agentId)?.find((record) => record.intentId === intentId);
  };
  const missing = (intent: IssuedIntent): string => {
    const home = homes.get(intent.agentRef.agentId);
    if (home === undefined) return 'the Agent home is missing';
    if (!home.internalDirectory) return 'the .byok directory is missing';
    if (home.ledgerBase64 === null) return 'the ledger is missing';
    return ledgers.has(intent.agentRef.agentId) ? 'the ledger has no record for it' : 'the ledger is unreadable';
  };

  const i2: string[] = [];
  for (const [intentId, completion] of receipts) {
    const intent = issued.get(intentId)!;
    const record = recordFor(intentId);
    if (record === undefined) i2.push(`intent ${intent.seq} (${intent.agentRef.agentId}): Host holds ${completion.outcome}, but ${missing(intent)}`);
    else if (recordOutcome(record) !== outcomeOf(completion)) {
      i2.push(`intent ${intent.seq}: Host holds ${outcomeOf(completion)}, device ledger is ${record.state} ${JSON.stringify(record.detail)}`);
    }
  }

  const i3: string[] = [];
  for (const intentId of acked) {
    const intent = issued.get(intentId)!;
    const record = recordFor(intentId);
    if (record === undefined) i3.push(`intent ${intent.seq}: acknowledged, but ${missing(intent)}`);
    else if (record.ackedAt === null) i3.push(`intent ${intent.seq}: acknowledged, but the device record has no ackedAt`);
  }

  const i4: string[] = [];
  const i5: string[] = [];
  for (const home of snapshot.homes) {
    // No ledger file means no applying barrier returned in this home.
    const records = home.ledgerBase64 === null ? [] : ledgers.get(home.agentId);
    if (records === undefined) i4.push(`${home.agentId}: the ledger is unreadable, so no memory state is allowed`);
    const paths = new Set([...Object.keys(home.files), ...(records ?? []).map((record) => record.path)]);
    for (const path of paths) {
      const file = home.files[path] ?? { exists: false, size: 0, revision: EMPTY_REVISION };
      const issuedTargets = new Set([...issued.values()]
        .filter((intent) => intent.agentRef.agentId === home.agentId && intent.path === path && intent.targetRevision !== null)
        .map((intent) => intent.targetRevision));
      if (file.revision !== EMPTY_REVISION && !issuedTargets.has(file.revision)) {
        i5.push(`${home.agentId}/${path}: ${file.size} bytes, ${file.revision} is no body the Host issued`);
      }
      if (records === undefined) continue;
      // The states each record leaves possible, in ledger (append) order, as
      // existence and revision together: a delete leaves no file and an empty
      // replace an empty one, both at EMPTY_REVISION, as
      // agentMemoryIntentAppliedConsistent() tells them apart. Before any
      // record the file is missing or the home skeleton's empty file. The CAS
      // compares revisions only, so an applying record matches either. A
      // terminal records the file right after its CAS, or as observed.
      let allowed: MemoryState[] = [{ exists: false, revision: EMPTY_REVISION }, { exists: true, revision: EMPTY_REVISION }];
      for (const record of records) {
        if (record.path !== path) continue;
        const detail = record.detail;
        if (record.state === 'applying') {
          if (allowed.some((state) => state.revision === record.baseRevision)) {
            allowed.push({ exists: record.operation === 'replace', revision: record.targetRevision ?? EMPTY_REVISION });
          }
        } else if (detail !== null && !('code' in detail)) {
          allowed = [{ exists: detail.exists, revision: detail.revision }];
        }
      }
      if (!allowed.some((state) => state.exists === file.exists && state.revision === file.revision)) {
        const states = allowed.map((state) => (state.exists ? `file ${state.revision}` : 'missing'));
        i4.push(`${home.agentId}/${path}: ${file.exists ? `${file.size} bytes ${file.revision}` : 'missing'}, ledger allows ${states.join(' | ')}`);
      }
    }
  }

  return {
    invariants: [result('I1', i1), result('I2', i2), result('I3', i3), result('I4', i4), result('I5', i5)],
    window: cutWindow(issued, receipts, acked, recordFor),
    leftovers: snapshot.homes.reduce((count, home) => count + home.leftovers.length, 0),
    leaseMarkers: snapshot.homes.filter((home) => home.leaseMarker === 'present').length,
  };
}

function cutWindow(
  issued: ReadonlyMap<string, IssuedIntent>,
  receipts: ReadonlyMap<string, AgentMemoryIntentCompletion>,
  acked: ReadonlySet<string>,
  recordFor: (intentId: string) => AgentMemoryIntentLedgerRecord | undefined,
): CutWindow {
  const last = [...issued.values()].at(-1);
  if (last === undefined) return 'no-intent';
  if (acked.has(last.intentId)) return 'acked';
  if (receipts.has(last.intentId)) return 'receipt-without-ack';
  const record = recordFor(last.intentId);
  if (record === undefined) return 'no-record';
  return record.state === 'applying' ? 'applying' : 'terminal-without-receipt';
}

/**
 * I6, from the journal entries of the recovery phase after one cut: each
 * intent open at the cut must end acknowledged, with no failed notice and no
 * repeat the Host found different from its stored completion.
 */
export function checkRecovery(open: readonly IssuedIntent[], recovery: readonly JournalEntry[]): InvariantResult {
  const details: string[] = [];
  for (const entry of recovery) {
    if (entry.kind === 'failed') details.push(`intent ${entry.intentId}: notice failed with ${entry.reason}`);
    if (entry.kind === 'repeat' && entry.disposition === 'conflict') {
      details.push(`intent ${entry.intentId}: the device completed it differently from the Host's stored completion`);
    }
  }
  for (const intent of open) {
    if (!recovery.some((entry) => entry.kind === 'acked' && entry.intentId === intent.intentId)) {
      details.push(`intent ${intent.seq}: still open after recovery`);
    }
  }
  return result('I6', details);
}
