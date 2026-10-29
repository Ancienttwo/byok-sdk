import type { AgentMemoryIntentAvailablePayload } from '@byok-sdk/protocol';
import { AgentHomeLeaseManager, AgentHomeManager, stableAgentHomeOwnerId } from '../../agent-home';
import {
  AgentMemoryIntentNoticeError,
  createAgentMemoryIntentProcessor,
  helperAgentMemoryIntentBackend,
  NATIVE_AGENT_MEMORY_INTENT_BACKEND,
  type AgentMemoryIntentBackend,
} from '../../daemon/agent-memory-intent';
import { resolveAgentMemoryFilesystemHelper } from '../../daemon/agent-memory-helper-release';
import {
  POWERCUT_DEVICE_ID,
  POWERCUT_TENANT_ID,
  readMessages,
  writeMessage,
  type HostMessage,
  type PowercutLink,
} from './protocol';
import { takeDeviceSnapshot } from './snapshot';
import { type AgentMemoryIntentTransport } from '@byok-sdk/protocol';

/**
 * The backend the production daemon would pick, with one test-only seam: on
 * Windows the helper reports `strictLedgerBarrier: false`, and the processor
 * refuses to run without it. The experiment claims B for this process only,
 * as the W4 smoke does, to measure whether the claim would hold. No
 * production gate or admission check reads this object.
 */
export function powercutBackend(): AgentMemoryIntentBackend {
  if (process.platform === 'linux') return NATIVE_AGENT_MEMORY_INTENT_BACKEND;
  const helper = helperAgentMemoryIntentBackend(resolveAgentMemoryFilesystemHelper());
  return process.platform === 'win32' ? { ...helper, strictLedgerBarrier: true } : helper;
}

/**
 * The device program: one snapshot of the store as found, then the real
 * intent processor over the real helper until the Host says stop or the
 * fault ends the process. Notices run one at a time, in arrival order.
 */
export async function runDevice(storeRoot: string, link: PowercutLink, backend: AgentMemoryIntentBackend): Promise<void> {
  writeMessage(link.output, { type: 'snapshot', snapshot: await takeDeviceSnapshot(storeRoot) });
  let nextId = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const call = (message: { type: 'fetch'; request: unknown } | { type: 'complete'; completion: unknown }) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      writeMessage(link.output, { ...message, id } as Parameters<typeof writeMessage>[1]);
    });
  const transport: AgentMemoryIntentTransport = {
    fetch: (request) => call({ type: 'fetch', request }),
    complete: (completion) => call({ type: 'complete', completion }),
  };
  const homes = new AgentHomeManager({
    hostStorageRoot: storeRoot,
    // The daemon's stable owner identity: a restart reclaims its own lease marker.
    leaseManager: new AgentHomeLeaseManager({ ownerId: stableAgentHomeOwnerId(storeRoot, 'byok-w5-powercut') }),
  });
  const processor = createAgentMemoryIntentProcessor({
    tenantId: POWERCUT_TENANT_ID, deviceId: POWERCUT_DEVICE_ID, transport, homes, backend,
  });
  let queue = Promise.resolve();
  const handle = async (payload: AgentMemoryIntentAvailablePayload): Promise<void> => {
    try {
      const result = await processor(payload);
      if (result.kind !== 'acknowledged') throw new Error(`unexpected ${result.kind}`);
      writeMessage(link.output, { type: 'acked', intentId: payload.intentId, completion: result.completion });
    } catch (error) {
      const reason = error instanceof AgentMemoryIntentNoticeError ? error.reason : String(error);
      writeMessage(link.output, { type: 'failed', intentId: payload.intentId, reason });
    }
  };
  writeMessage(link.output, { type: 'ready' });
  for await (const message of readMessages<HostMessage>(link.input)) {
    switch (message.type) {
      case 'notice':
        queue = queue.then(() => handle(message.payload));
        break;
      case 'reply': {
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.ok) pending?.resolve(message.value);
        else pending?.reject(new Error('Host transport failure'));
        break;
      }
      case 'stop':
        await queue;
        return;
    }
  }
  await queue;
}
