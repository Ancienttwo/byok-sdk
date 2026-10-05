import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupCapture, providerEndpoint, prepareOnThisDevice, startPrepared, tempDir } from './fixtures/clarification-prepared-capture';

// This suite does not claim cloud/daemon production admission: the real service
// receipts stay ready=false because counter=test_fixture and tools unattested.
// It proves fresh source/artifact identity + native first-request bytes offline.
afterEach(cleanupCapture);

describe('clarification answer -> new preparation -> own frozen first request', () => {
  it('creates two persisted receipts/Ds and sends the answer Execution own D, never the old D', async () => {
    const endpoint = await providerEndpoint(); const storeDir = await tempDir('pc-');
    const first = await prepareOnThisDevice(endpoint,{ storeDir,requestId: 'prep-before-answer',sourceRevision: 'context-1',message: 'Export invoices. Ask which period before exporting.' });
    const second = await prepareOnThisDevice(endpoint,{ storeDir,requestId: 'prep-after-answer',sourceRevision: 'context-2',message: 'Export invoices. Validated clarification answer: current-month only.' });
    for (const prepared of [first,second]) {
      expect(prepared.receipt.ready).toBe(false);
      expect(prepared.receipt.counter?.authority).toBe('test_fixture');
      expect(prepared.receipt.readinessReasons).toContain('counter_authority_not_production');
      const artifact = JSON.parse(await readFile(prepared.artifactPath,'utf8'));
      expect(artifact.recordId).toBe(prepared.receipt.reference);
      expect(artifact.requestDigest).toBe(prepared.receipt.artifact!.requestDigest);
      expect(artifact.requestBody).toBe(prepared.requestBody);
      expect(Buffer.byteLength(artifact.requestBody)).toBe(prepared.receipt.artifact!.requestBytes);
    }
    expect(second.receipt.reference).not.toBe(first.receipt.reference);
    expect(second.receipt.binding.source).not.toEqual(first.receipt.binding.source);
    expect(second.receipt.artifact!.requestDigest).not.toBe(first.receipt.artifact!.requestDigest);
    expect(second.receipt.artifact!.envelopeDigest).not.toBe(first.receipt.artifact!.envelopeDigest);
    expect(second.requestBody).not.toBe(first.requestBody);
    expect(second.requestBody).toContain('current-month only'); expect(first.requestBody).not.toContain('current-month only');
    const lookup = await second.service.lookup({ requestId: 'prep-before-answer',scope: {
      deviceId: 'offline-device',agentRef: 'offline-agent',profileId: 'offline-profile',profileRevision: '1',
    } });
    expect(lookup.reference).toBe(first.receipt.reference); // old receipt remains history, not reused.
    for (const [index,prepared] of [first,second].entries()) {
      const session = await startPrepared(prepared,{ taskId: `capture-execution-${index + 1}` });
      for await (const event of session.events) {
        if (event.type === 'error') throw new Error(`Native capture failed: ${JSON.stringify(event)}`);
        if (event.type === 'turn_end') break;
      }
      await session.close();
      expect(endpoint.bodies).toHaveLength(index + 1);
      expect(endpoint.bodies[index]).toBe(prepared.requestBody);
    }
    expect(endpoint.bodies[1]).toBe(second.requestBody);
    expect(endpoint.bodies[1]).not.toBe(first.requestBody);
  },60_000);

  it('mixing old artifact with new receipt expectations refuses before any provider transport', async () => {
    const endpoint = await providerEndpoint(); const storeDir = await tempDir('pc-');
    const first = await prepareOnThisDevice(endpoint,{ storeDir,requestId: 'old',sourceRevision: 'context-1',message: 'Export invoices. Waiting for answer.' });
    const second = await prepareOnThisDevice(endpoint,{ storeDir,requestId: 'new',sourceRevision: 'context-2',message: 'Validated answer: current-month only.' });
    // Direct launcher boundary probe, not an attempt to claim a non-ready task.
    await expect(startPrepared(second,{ taskId: 'mixed-execution',preparation: {
      ...second.preparation,artifactPath: first.artifactPath,
    } })).rejects.toThrow('artifact belonging to a different preparation record');
    expect(endpoint.bodies).toHaveLength(0);
    expect(first.receipt.ready).toBe(false); expect(second.receipt.ready).toBe(false);
  },60_000);
});
