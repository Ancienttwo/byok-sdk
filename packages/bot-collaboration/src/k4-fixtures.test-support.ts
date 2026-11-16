import type { AgentEgressPolicy } from '@byok-sdk/client';
import type { ExecutionTemplate } from '@byok-sdk/server/execution-core';

/**
 * #1845 S1: the K4 test data that K8 reads, owned here so K8 needs no private example to typecheck or to run its
 * vectors. The values are the ones `examples/host-execution-core/src/test-support.ts` uses, so the daemon admits the
 * same egress policy revision and the routine and delivery vectors see the same template.
 * Only types come from the packages, so this module loads wherever the vectors do.
 */
export const policy: AgentEgressPolicy = {
  policyRevision: 'k4-v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
};

export function template(deviceId: string, agentId = 'main'): ExecutionTemplate {
  return { deviceId, payload: { runtime: 'pi', session: { mode: 'fresh' }, instruction: 'Return the test result through submit_result.',
    agentRef: { agentId, profileRevision: '1' }, egressPolicy: policy,
    terminalProjection: { mode: 'result-document', contract: 'host-core-test-v1', schema: {
      type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } },
    } },
  } };
}
