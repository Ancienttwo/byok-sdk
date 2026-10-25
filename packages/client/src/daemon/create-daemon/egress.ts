import type { AgentReliableEgressRecord } from '../agent-egress-spool';
import { AGENT_EGRESS_RELIABLE_ACK_CAPABILITY, createEnvelope, AgentContentReceiptPayloadSchema } from '@byok-sdk/protocol';
import type { AgentEgressReliablePayload } from '@byok-sdk/protocol';
import type { AgentEgressReliableAppendResult } from '../agent-egress-controller';
import type { AgentReliableEgressInput } from '../create-daemon';
import type { DaemonScope } from './scope';

/** Reliable Agent egress dispatch and publication (#926). */

export function dispatchReliableRecord(daemonScope: DaemonScope, record: AgentReliableEgressRecord): void {
  const { daemonState, reliableEnvelopes } = daemonScope;
  if (record.sessionRef === undefined) {
    daemonState.agentEgress.noteTransportDrop('invalid_envelope', record.agentRef);
    return;
  }
  if (!daemonState.connection?.getServerCapabilities().includes(AGENT_EGRESS_RELIABLE_ACK_CAPABILITY)) {
    // The append stays durable and is retried when an advertisement next
    // carries the ack capability (`onCapabilitiesAdvertised`). It is never
    // republished through latest-value activity.
    daemonState.agentEgress.noteTransportDrop('capability_missing', record.agentRef);
    return;
  }
  const envelope = reliableEnvelopes.get(record) ?? (record.wireType === 'agent.egress.reliable'
    ? createEnvelope('agent.egress.reliable', {
        agentRef: record.agentRef,
        sessionRef: record.sessionRef,
        policyRevision: record.policyRevision,
        eventId: record.eventId,
        cursor: record.cursor,
        payload: record.payload as AgentEgressReliablePayload['payload'],
        contentHash: record.payloadHash,
        byteCount: record.byteCount,
      }, {
        ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
        sessionRef: record.sessionRef,
      })
    : createEnvelope(
        'agent.content.receipt',
        AgentContentReceiptPayloadSchema.parse(record.payload),
        {
          ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
          sessionRef: record.sessionRef,
        },
      ));
  reliableEnvelopes.set(record, envelope);
  daemonState.connection.send(envelope);
}

export async function publishReliableAgentEgress(daemonScope: DaemonScope, input: AgentReliableEgressInput): Promise<AgentEgressReliableAppendResult> {
  const { config, agentHomeManager, agentSessionHandoffs, daemonState, dispatchReliableRecord } = daemonScope;
  if (config.agentEgress === undefined || agentHomeManager === undefined || agentSessionHandoffs === undefined) {
    throw new Error('Agent reliable egress is not configured');
  }
  if (daemonState.tenantRebinding) {
    throw new Error('tenant enrollment is being re-paired; reliable egress is blocked until restart');
  }
  const binding = await agentHomeManager.acquire(input.agentRef);
  try {
    await agentHomeManager.initialize(binding);
    const handoff = await agentSessionHandoffs.requireMatch({
      agentRef: binding.resolution.agentRef,
      sessionRef: input.sessionRef,
      runtimeId: input.runtimeId,
      cwd: binding.resolution.canonicalHome,
    });
    if (handoff.taskId !== input.taskId) {
      throw new Error('Agent reliable egress taskId does not match the durable session handoff');
    }
    const appended = await daemonState.agentEgress.appendReliable({
      homeDir: binding.resolution.canonicalHome,
      agentRef: binding.resolution.agentRef,
      sessionRef: input.sessionRef,
      payload: input.payload,
      taskId: input.taskId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    });
    if (appended.ok) dispatchReliableRecord(appended.record);
    return appended;
  } finally {
    await binding.lease.release();
  }
}
