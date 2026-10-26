import { expect, it } from 'vitest';
import { agentMemoryIntentOperationDigest } from '@byok-sdk/core';
import { serializeAgentMemoryIntentLedger, type AgentMemoryIntentLedgerRecord } from '../daemon/agent-memory-intent';
import { checkCut } from './agent-memory-powercut/checker';
import type { IssuedIntent, JournalEntry } from './agent-memory-powercut/host';
import { POWERCUT_DEVICE_ID, POWERCUT_TENANT_ID } from './agent-memory-powercut/protocol';
import { EMPTY_REVISION, revisionOf, type FileObservation } from './agent-memory-powercut/snapshot';

// Pure snapshots only: no driver, guest, helper, network or filesystem mutation.
async function check(operation: 'delete' | 'replace', state: 'applied' | 'applying', file: FileObservation, priorNonempty = false) {
  const targetRevision = operation === 'delete' ? null : EMPTY_REVISION;
  const intent: IssuedIntent = {
    seq: 0, intentId: '00000000-0000-4000-8000-000000000001',
    agentRef: { agentId: 'agent', profileRevision: '1' }, path: 'notes/a.md',
    operation, baseRevision: operation === 'replace' || priorNonempty ? revisionOf(Buffer.from('old')) : EMPTY_REVISION, targetRevision, operationDigest: '',
  };
  const approvalRef = 'approval:test';
  const issued = { ...intent, operationDigest: await agentMemoryIntentOperationDigest({ ...intent,
    tenantId: POWERCUT_TENANT_ID, deviceId: POWERCUT_DEVICE_ID, approvalRef }) };
  const result = { exists: operation === 'replace', revision: EMPTY_REVISION };
  const stamp = '2026-10-26T00:00:00.000Z';
  const record: AgentMemoryIntentLedgerRecord = {
    intentId: issued.intentId, profileRevision: '1', path: issued.path, operation,
    operationDigest: issued.operationDigest, baseRevision: issued.baseRevision, targetRevision, approvalRef,
    state, detail: state === 'applied' ? result : null,
    createdAt: stamp, updatedAt: stamp, ackedAt: state === 'applied' ? stamp : null,
  };
  const journal: JournalEntry[] = [{ kind: 'issued', intent: issued }];
  const records = [record];
  if (priorNonempty) {
    const prior = { ...issued, intentId: '00000000-0000-4000-8000-000000000002',
      operation: 'replace' as const, baseRevision: EMPTY_REVISION, targetRevision: issued.baseRevision };
    prior.operationDigest = await agentMemoryIntentOperationDigest({ ...prior,
      tenantId: POWERCUT_TENANT_ID, deviceId: POWERCUT_DEVICE_ID, approvalRef });
    journal.unshift({ kind: 'issued', intent: prior });
    records.unshift({ ...record, intentId: prior.intentId, operation: prior.operation,
      operationDigest: prior.operationDigest, baseRevision: prior.baseRevision, targetRevision: prior.targetRevision,
      state: 'applied', detail: { exists: true, revision: prior.targetRevision }, ackedAt: stamp });
  }
  if (state === 'applied') journal.push({ kind: 'receipt', intentId: issued.intentId, completion: {
    intentId: issued.intentId, agentRef: issued.agentRef, path: issued.path, operation,
    operationDigest: issued.operationDigest, outcome: 'applied', result,
  } }, { kind: 'acked', intentId: issued.intentId });
  return checkCut({ platform: 'test', arch: 'test', runtime: 'test', homes: [{
    agentId: 'agent', notesDirectory: true, internalDirectory: true,
    ledgerBase64: Buffer.from(serializeAgentMemoryIntentLedger(records)).toString('base64'),
    files: { 'notes/a.md': file }, leftovers: [], leaseMarker: 'absent',
  }] }, journal);
}

it.each(['delete', 'replace'] as const)('distinguishes an acknowledged %s from the opposite empty state', async operation => {
  const report = await check(operation, 'applied', { exists: operation === 'delete', size: 0, revision: EMPTY_REVISION });
  expect(report.invariants.filter(row => row.status === 'violated').map(row => row.id)).toEqual(['I4']);
});

it.each([
  [{ exists: true, size: 3, revision: revisionOf(Buffer.from('old')) }, []],
  [{ exists: false, size: 0, revision: EMPTY_REVISION }, []],
  [{ exists: true, size: 0, revision: EMPTY_REVISION }, ['I4']],
  [{ exists: false, size: 0, revision: revisionOf(Buffer.from('old')) }, ['I4', 'I5']],
] as const)('limits an applying delete after nonempty memory to its pre/post-CAS states: %j', async (file, violations) => {
  const report = await check('delete', 'applying', file, true);
  expect(report.invariants.filter(row => row.status === 'violated').map(row => row.id)).toEqual(violations);
});

it.each(['delete', 'replace'] as const)('accepts the exact acknowledged %s state', async operation => {
  const report = await check(operation, 'applied', { exists: operation === 'replace', size: 0, revision: EMPTY_REVISION });
  expect(report.invariants.every(row => row.status === 'held')).toBe(true);
});

it.each([false, true])('keeps pre/post-CAS empty states possible for an applying delete (exists=%s)', async exists => {
  const report = await check('delete', 'applying', { exists, size: 0, revision: EMPTY_REVISION });
  expect(report.invariants.every(row => row.status === 'held')).toBe(true);
});
