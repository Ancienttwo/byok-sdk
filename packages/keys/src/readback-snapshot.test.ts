/**
 * F7 (Codex SDK acceptance round 3): the public readback must observe the
 * atomic reservation → receipt handoff consistently. Two SQLite connections on
 * one file: connection A runs a real apply and is held at `after-secret-write`
 * (reservation durable, no receipt); connection B's readback is held right
 * after its receipt read; A then commits normally (receipt written,
 * reservation removed in one transaction) and B resumes. Explicit latches, no
 * sleeps, no substituted query results.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { providerProvisioningRequestDigest } from '@byok-sdk/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceSealingKeyStore } from './device-sealing-key';
import { DEVICE, NOW, PROFILE_REF, TENANT, configureRequest, placedIdentity } from './fixtures/provisioning-requests';
import { applySealedProviderProvisioning, readSealedProvisioningResult } from './sealed-provisioning';
import { InMemorySecretStore } from './secret-store';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

let dir: string;
let writer: SqliteProviderProfileStore;
let reader: SqliteProviderProfileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'byok-keys-readback-'));
  writer = new SqliteProviderProfileStore({ path: join(dir, 'provider-profile.sqlite') });
  reader = new SqliteProviderProfileStore({ path: join(dir, 'provider-profile.sqlite') });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reader.close();
  await writer.close();
  rmSync(dir, { recursive: true, force: true });
});

async function handoffRace(readerDigest: (original: string) => string) {
  const secrets = new InMemorySecretStore();
  const sealingKey = await new DeviceSealingKeyStore({ secretStore: secrets }).loadOrCreate({ tenantId: TENANT, deviceId: DEVICE });
  const request = await configureRequest(sealingKey, 'sk-f7-handoff', { requestId: 'handoff', generation: 1 });
  const digest = await providerProvisioningRequestDigest(request);

  const writerAtCut = latch();
  const releaseWriter = latch();
  const applying = applySealedProviderProvisioning({
    request,
    profileStore: writer,
    secretStore: secrets,
    sealingKey,
    resolveProfileRef: () => PROFILE_REF,
    readIdentity: async () => placedIdentity(),
    now: () => new Date(NOW),
    faults: {
      async onCutPoint(point) {
        if (point !== 'after-secret-write') return;
        writerAtCut.open();
        await releaseWriter.promise;
      },
    },
  });
  await writerAtCut.promise;
  const reservationPresentBefore = (await reader.getReservation('handoff')) !== undefined;

  const readerAfterReceipt = latch();
  const releaseReader = latch();
  const realGetReceipt = reader.getReceipt.bind(reader);
  vi.spyOn(reader, 'getReceipt').mockImplementationOnce(async (requestId) => {
    const receipt = await realGetReceipt(requestId);
    readerAfterReceipt.open();
    await releaseReader.promise;
    return receipt;
  });
  const set = vi.spyOn(secrets, 'set');
  const reading = readSealedProvisioningResult({ profileStore: reader, requestId: 'handoff', requestDigest: readerDigest(digest) });
  await readerAfterReceipt.promise;

  releaseWriter.open();
  const applied = await applying;
  releaseReader.open();
  const readback = await reading;

  return {
    reservationPresentBefore,
    applied,
    readback,
    finalReceipt: await reader.getReceipt('handoff'),
    finalReservation: await reader.getReservation('handoff'),
    secretWritesDuringRead: set.mock.calls.length,
  };
}

describe.skipIf(!isSqliteAvailable())('F7: readback observes the reservation → receipt handoff consistently', () => {
  it('F7 same digest across the handoff reads back the completed result, never absent', async () => {
    const race = await handoffRace((digest) => digest);
    expect(race.reservationPresentBefore).toBe(true);
    expect(race.applied.outcome).toBe('applied');
    expect(race.finalReservation).toBeUndefined();
    expect(race.finalReceipt?.result).toEqual(race.applied);
    expect(race.readback).toEqual({ status: 'completed', result: race.applied });
    expect(race.secretWritesDuringRead).toBe(0);
  });

  it('F7 different digest across the handoff is a conflict, never absent', async () => {
    const race = await handoffRace(() => `sha256:${'f'.repeat(64)}`);
    expect(race.reservationPresentBefore).toBe(true);
    expect(race.applied.outcome).toBe('applied');
    expect(race.finalReceipt?.result).toEqual(race.applied);
    expect(race.readback).toEqual({ status: 'conflict' });
    expect(race.secretWritesDuringRead).toBe(0);
  });
});
