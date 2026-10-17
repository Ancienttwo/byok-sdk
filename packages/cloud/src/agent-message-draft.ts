import type { TenantId } from '@byok-sdk/core';
import { AgentRefSchema, type AgentRef } from '@byok-sdk/protocol';
import { readDeviceTerminalReceipt } from './terminal-result';
import { terminalReceiptKey } from './inbound';
import type { TenantStores } from './tenant-stores';
import { readTaskAgentMessage, readTaskAgentMessageBinding } from './task-agent-message';

export interface AgentMessageDraftCursor {
  readonly revision: number;
  readonly offset: number;
}
export interface AgentMessageDraftRow {
  readonly taskId: string;
  readonly deviceId: string;
  readonly agentRef: AgentRef;
  readonly revision: number;
  readonly text: string;
  readonly byteCount: number;
  readonly state: 'open' | 'overflow' | 'gap';
  readonly updatedAt: string;
  readonly expiresAt: string;
}
export interface AgentMessageDraftApplyInput extends AgentMessageDraftCursor {
  readonly taskId: string;
  readonly deviceId: string;
  readonly agentRef: AgentRef;
  readonly text: string;
  readonly overflow?: true;
  readonly maxBytes: number;
  readonly now: string;
}
export type AgentMessageDraftApplyResult = 'applied' | 'stale' | 'gap' | 'overflow';
export interface AgentMessageDraftStore {
  apply(tenant: TenantId, input: AgentMessageDraftApplyInput): Promise<AgentMessageDraftApplyResult>;
  read(tenant: TenantId, taskId: string): Promise<AgentMessageDraftRow | undefined>;
  delete(tenant: TenantId, taskId: string): Promise<void>;
  sweepExpired(now: string): Promise<void>;
}
export interface AgentMessageDraftReadback extends AgentMessageDraftCursor {
  readonly text: string;
  readonly byteCount: number;
  readonly state: AgentMessageDraftRow['state'] | 'ended' | 'discarded';
}

/** The cursor is a UTF-8 boundary. A cursor beyond retained text has no suffix. */
export function agentMessageDraftSuffix(text: string, cursor: AgentMessageDraftCursor | undefined, revision: number): { offset: number; text: string } {
  if (cursor === undefined || cursor.revision !== revision) return { offset: 0, text };
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new RangeError('Draft offset must be a non-negative integer.');
  const bytes = new TextEncoder().encode(text);
  const suffix = bytes.subarray(cursor.offset);
  // A byte inside a code point must not produce a replacement character.
  return { offset: cursor.offset, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(suffix) };
}

export async function readTaskAgentMessageDraft(
  stores: TenantStores, deviceId: string, taskId: string, expectedRef: AgentRef, cursor?: AgentMessageDraftCursor,
): Promise<AgentMessageDraftReadback | undefined> {
  const agentRef = AgentRefSchema.parse(expectedRef);
  const binding = await readTaskAgentMessageBinding(stores, deviceId, taskId, agentRef);
  if (binding === undefined) return undefined;
  const terminal = await stores.receipts.get(terminalReceiptKey(taskId));
  if (terminal !== undefined) readDeviceTerminalReceipt(taskId, terminal);
  const message = await readTaskAgentMessage(stores, deviceId, taskId, agentRef);
  // Read text after the state authorities so an ending state cannot use an older snapshot.
  const row = await stores.agentMessageDraft.read(taskId);
  if (row !== undefined && (row.taskId !== taskId || row.deviceId !== deviceId
    || row.agentRef.agentId !== agentRef.agentId || row.agentRef.profileRevision !== agentRef.profileRevision)) {
    throw new Error('Invalid persisted task Agent message draft.');
  }
  // A refusal is not a published message. Pending, held and accepted admissions
  // have already ended the draft lane; only their product disposition differs.
  const state = message !== undefined && message.disposition?.outcome !== 'refused' ? 'ended'
    : message?.disposition?.outcome === 'refused' || terminal !== undefined ? 'discarded'
    : row?.state ?? 'open';
  const revision = row?.revision ?? 0;
  return { revision, ...agentMessageDraftSuffix(row?.text ?? '', row === undefined ? undefined : cursor, revision), byteCount: row?.byteCount ?? 0, state };
}
