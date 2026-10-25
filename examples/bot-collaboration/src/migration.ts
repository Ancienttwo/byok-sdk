import { canonical, hash } from '@byok-sdk/example-host-execution-core/canonical';
import type { Conclusion, Json, Occurrence, Routine } from '@byok-sdk/example-host-execution-core';
import type { CollaborationState } from './model';

/**
 * The state that an L/H owner switch moves (#975, design §8): one coordination domain, an L ledger tenant or an H scope,
 * exported by the old owner after every device of the domain is frozen and drained, and imported by the new owner into an
 * empty domain. Both Hosts read and write this one neutral form, so neither Host's storage is the format. The old owner
 * seals it; the new owner verifies it, writes it, reads its own rows back into this form, and compares the digest.
 */
export const SWITCH_EXPORT_VERSION = 1;
export const SWITCH_SECTIONS = ['collaboration', 'archived', 'intents', 'routines', 'occurrences', 'slots', 'outbox', 'tombstones'] as const;
export type SwitchSection = typeof SWITCH_SECTIONS[number];

/** A device of the domain and its revision on the source Host, frozen by the source's open switch. */
export interface SwitchDevice { deviceId: string; frozenRevision: number }
/** A K8 retention row (#798), `commands` included, with its absolute expiry. The importer keeps the expiry. */
export interface ArchivedRecord { namespace: string; id: string; body: Json; expiresAt?: number }
/**
 * A stored intent, as both Hosts keep it. The domain is drained, so it is concluded. A late terminal or message for it is
 * refused by its conclusion; one for a compacted intent, by its `intent` tombstone.
 */
export interface IntentRecord {
  key: string; source: 'user' | 'bot' | 'routine'; handler?: string; taskId: string; generation: number;
  deviceId: string; agentId: string; conclusion: Conclusion; started: boolean;
  cancelReason?: 'expired' | 'cancelled'; retryUntil?: number;
}
export interface RoutineRecord { id: string; routine: Routine }
/** A routine slot's replay guard: the slot hash and its occurrence key. */
export interface SlotRecord { slot: string; occurrenceKey: string }
/** An unconfirmed outbox record under its original identity. The receiver deduplicates a projection by its id. */
export type OutboxRecord = { kind: 'projection'; id: string; value: Json } | { kind: 'host-job'; occurrenceKey: string };
/** A permanent or expiring tombstone in the K4 scheme: the digest of the retired identity, by kind. */
export interface TombstoneRecord { kind: 'intent' | 'row' | 'slot' | 'application'; digest: string; expiresAt?: number }

export interface SwitchContent {
  version: typeof SWITCH_EXPORT_VERSION; source: 'L' | 'H'; domain: string; devices: SwitchDevice[]; exportedAt: number;
  /** The live state. The source Host's owner records (L `topology`) are not part of it. */
  collaboration: CollaborationState;
  archived: ArchivedRecord[]; intents: IntentRecord[]; routines: RoutineRecord[]; occurrences: Occurrence[];
  slots: SlotRecord[]; outbox: OutboxRecord[]; tombstones: TombstoneRecord[];
}
/** The count and digest of each section, and `digest` over them and the header: the identity of one export. */
export interface SwitchManifest { counts: Record<SwitchSection, number>; digests: Record<SwitchSection, string>; digest: string }
export interface SwitchExport extends SwitchContent { manifest: SwitchManifest }

export type SwitchExportRefusal = 'invalid' | 'unsorted' | 'duplicate' | 'owner_record' | 'device_missing' | 'open_work'
  | 'home_sent' | 'card_call' | 'manifest';
/** An export that the format refuses. Nothing may be imported or committed from it. */
export class SwitchExportError extends Error {
  readonly code = 'switch_export_refused' as const;
  constructor(readonly reason: SwitchExportRefusal, message: string) { super(message); this.name = 'SwitchExportError'; }
}

/** The identity that orders each section and must be unique in it. */
const IDENTITY: { [S in Exclude<SwitchSection, 'collaboration'>]: (row: SwitchContent[S][number]) => Json } = {
  archived: row => [(row as ArchivedRecord).namespace, (row as ArchivedRecord).id],
  intents: row => (row as IntentRecord).key,
  routines: row => (row as RoutineRecord).id,
  occurrences: row => (row as Occurrence).key,
  slots: row => (row as SlotRecord).slot,
  outbox: row => { const out = row as OutboxRecord; return [out.kind, out.kind === 'projection' ? out.id : out.occurrenceKey]; },
  tombstones: row => [(row as TombstoneRecord).kind, (row as TombstoneRecord).digest],
};
const LISTS = SWITCH_SECTIONS.filter((section): section is Exclude<SwitchSection, 'collaboration'> => section !== 'collaboration');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Seals the old owner's content: checks it, orders each section by its identity and computes the manifest. Returns a new
 * document; the content is not changed. Throws `SwitchExportError` for content that no target may import.
 */
export function sealSwitchExport(content: SwitchContent): SwitchExport {
  const sealed = structuredClone(content) as SwitchContent;
  checkContent(sealed);
  for (const section of LISTS) {
    const key = IDENTITY[section] as (row: unknown) => Json;
    (sealed[section] as unknown[]).sort((a, b) => compare(canonical(key(a)), canonical(key(b))));
  }
  checkOrder(sealed);
  return { ...sealed, manifest: manifestOf(sealed) };
}

/**
 * Verifies a document before an import, and the new owner's read-back after it: the format checks, each section in its
 * one order with unique identities, and the manifest recomputed from the content. Returns the manifest.
 */
export function verifySwitchExport(document: SwitchExport): SwitchManifest {
  checkContent(document);
  checkOrder(document);
  const manifest = manifestOf(document);
  if (canonical(manifest) !== canonical(document.manifest)) {
    throw new SwitchExportError('manifest', `Switch export manifest does not match its content: ${document.manifest?.digest} != ${manifest.digest}`);
  }
  return manifest;
}

function manifestOf(content: SwitchContent): SwitchManifest {
  const counts = {} as Record<SwitchSection, number>, digests = {} as Record<SwitchSection, string>;
  counts.collaboration = 1;
  digests.collaboration = hash(content.collaboration);
  for (const section of LISTS) {
    counts[section] = content[section].length;
    digests[section] = hash(content[section]);
  }
  const header = { version: content.version, source: content.source, domain: content.domain, devices: content.devices, exportedAt: content.exportedAt };
  return { counts, digests, digest: hash({ header, counts, digests }) };
}

function checkOrder(content: SwitchContent): void {
  for (const section of LISTS) {
    const key = IDENTITY[section] as (row: unknown) => Json;
    const keys = (content[section] as unknown[]).map(row => canonical(key(row)));
    for (let i = 1; i < keys.length; i++) {
      const order = compare(keys[i - 1]!, keys[i]!);
      if (order === 0) throw new SwitchExportError('duplicate', `Switch export ${section} repeats ${keys[i]}`);
      if (order > 0) throw new SwitchExportError('unsorted', `Switch export ${section} is not in identity order at ${keys[i]}`);
    }
  }
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const digestText = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
function invalid(message: string): never { throw new SwitchExportError('invalid', `Invalid switch export: ${message}`); }
function ensure(ok: boolean, message: string): void { if (!ok) invalid(message); }

function checkContent(content: SwitchContent): void {
  ensure(object(content), 'not an object');
  ensure(content.version === SWITCH_EXPORT_VERSION, `version ${String(content.version)}`);
  ensure(content.source === 'L' || content.source === 'H', 'source');
  ensure(text(content.domain), 'domain');
  ensure(time(content.exportedAt), 'exportedAt');
  ensure(Array.isArray(content.devices) && content.devices.length > 0, 'devices');
  for (const device of content.devices) ensure(object(device) && text(device.deviceId) && time(device.frozenRevision) && device.frozenRevision >= 1, 'device');
  if (new Set(content.devices.map(device => device.deviceId)).size !== content.devices.length) {
    throw new SwitchExportError('duplicate', 'Switch export lists a device twice');
  }
  for (const section of LISTS) ensure(Array.isArray(content[section]), section);
  checkCollaboration(content);
  for (const row of content.archived) ensure(object(row) && text(row.namespace) && text(row.id) && row.body !== undefined && optional(row.expiresAt, time), 'archived row');
  for (const row of content.intents) {
    ensure(object(row) && text(row.key) && ['user', 'bot', 'routine'].includes(row.source) && optional(row.handler, text) && digestText(row.taskId)
      && time(row.generation) && text(row.deviceId) && text(row.agentId) && typeof row.started === 'boolean'
      && optional(row.cancelReason, value => value === 'expired' || value === 'cancelled') && optional(row.retryUntil, time), 'intent');
    if (!text(row.conclusion)) throw new SwitchExportError('open_work', `Switch export has an open intent: ${row.key}`);
  }
  for (const row of content.routines) ensure(object(row) && text(row.id) && object(row.routine), 'routine');
  for (const row of content.occurrences) ensure(object(row) && text(row.key) && text(row.routineId), 'occurrence');
  for (const row of content.slots) ensure(object(row) && text(row.slot) && text(row.occurrenceKey), 'slot');
  for (const row of content.outbox) {
    ensure(object(row) && (row.kind === 'projection' ? text(row.id) && row.value !== undefined : row.kind === 'host-job' && text(row.occurrenceKey)), 'outbox row');
  }
  for (const row of content.tombstones) {
    ensure(object(row) && ['intent', 'row', 'slot', 'application'].includes(row.kind) && digestText(row.digest) && optional(row.expiresAt, time), 'tombstone');
  }
}

/**
 * The live state of a drained domain: no owner record of the source, every live Bot on a device of the export, no Turn or
 * input batch left open, no Agent home write that may have reached a device, and no card call in flight.
 */
function checkCollaboration(content: SwitchContent): void {
  const state = content.collaboration;
  ensure(object(state) && state.version === 3 && object(state.team) && object(state.turns), 'collaboration state');
  if (state.topology !== undefined) throw new SwitchExportError('owner_record', 'Switch export carries the source owner records (topology)');
  const devices = new Set(content.devices.map(device => device.deviceId));
  for (const bot of Object.values(state.team.bots)) {
    if (!bot.archived && !devices.has(bot.execution.deviceId)) {
      throw new SwitchExportError('device_missing', `Bot ${bot.id} runs on device ${bot.execution.deviceId}, which the export does not move`);
    }
  }
  for (const turn of Object.values(state.turns)) {
    if (!turn.conclusion) throw new SwitchExportError('open_work', `Switch export has an open Turn: ${turn.id}`);
  }
  for (const batch of Object.values(state.inputBatches ?? {})) {
    if (batch.state === 'open') throw new SwitchExportError('open_work', `Switch export has an open input batch: ${batch.id}`);
  }
  for (const op of state.team.homeOperations) {
    // A write that may have reached a device is the old owner's to settle before the export (#957); only an unsent one moves.
    if (op.status === 'pending' && (op.sent || op.retryAt !== undefined)) {
      throw new SwitchExportError('home_sent', `Switch export has a pending Agent home write that may have been sent: ${op.sequence}`);
    }
  }
  if (Object.keys(state.cardCalls ?? {}).length) throw new SwitchExportError('card_call', 'Switch export has a card call in flight');
}
