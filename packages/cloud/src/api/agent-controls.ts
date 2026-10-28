import type { ByokCloud, ByokCloudOptions, EnqueuedAgentControl } from '../cloud';
import { uuidFromSha256 } from '../offer-identity';
import { requiredReceiverCapabilities } from '@byok-sdk/protocol';
import { type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import {
  createEnvelope,
  type Envelope,
  AgentContentReadPayloadSchema,
  AgentHomeProjectionPayloadSchema,
  AgentInputPreparationPayloadSchema,
  ProviderProvisioningAvailablePayloadSchema,
  AgentMemoryIntentAvailablePayloadSchema,
  type AgentRef,
} from '@byok-sdk/protocol';
import { ByokCloudError } from '../errors';
import { agentHomeProjectionRequestKey, sameAgentHomeProjectionRequest } from '../agent-home-projections';
import { inputPreparationRequestKey, sameInputPreparationRequest } from '../input-preparations';
import { agentReliabilityKey } from '../agent-reliability';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
  assertAgentCapabilities: (tenant: TenantId, deviceId: string, required: readonly string[]) => Promise<void>;
  enqueueAgentControlEnvelope: (tenant: TenantId, deviceId: string, messageId: string, buildEnvelope: (seq: number) => Envelope) => Promise<EnqueuedAgentControl>;
  agentControlEnvelopeId: (domain: string, tenant: TenantId, deviceId: string, agentRef: AgentRef, logicalRequestId: string) => Promise<string>;
  getAgentHomeProjectionStatus: ByokCloud['getAgentHomeProjectionStatus'];
  getInputPreparationStatus: ByokCloud['getInputPreparationStatus'];
}

export function createAgentControlsApi({
  root,
  controlPlane,
  options,
  assertAgentCapabilities,
  enqueueAgentControlEnvelope,
  agentControlEnvelopeId,
  getAgentHomeProjectionStatus,
  getInputPreparationStatus,
}: Dependencies): Pick<ByokCloud,
  | 'enqueueAgentContentRead'
  | 'enqueueAgentHomeProjection'
  | 'enqueueInputPreparation'
  | 'enqueueProviderProvisioningNotice'
  | 'enqueueAgentMemoryIntentNotice'
> {
  return {
    async enqueueAgentContentRead(tenant, deviceId, input) {
      const payload = AgentContentReadPayloadSchema.parse(input.payload);
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('agent.content.read', payload));
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const persisted = await stores.receipts.record({
        key: agentReliabilityKey('agent-content-request', deviceId, payload.agentRef, payload.requestId),
        body: JSON.stringify(payload),
      });
      if (!persisted.created && persisted.receipt.body !== JSON.stringify(payload)) {
        throw new ByokCloudError(
          'agent_content_request_mismatch',
          `Request ${payload.requestId} already exists with a different immutable content-read body.`,
        );
      }
      const messageId = await agentControlEnvelopeId(
        'byok:agent-content-read',
        tenant,
        deviceId,
        payload.agentRef,
        payload.requestId,
      );
      const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
        createEnvelope('agent.content.read', payload, { id: messageId, seq }),
      );
      if (
        control.envelope.type !== 'agent.content.read' ||
        JSON.stringify(control.envelope.payload) !== JSON.stringify(payload)
      ) {
        throw new ByokCloudError(
          'agent_content_request_mismatch',
          `Request ${payload.requestId} already exists with a different immutable content-read body.`,
        );
      }
      return control;
    },

    async enqueueAgentHomeProjection(tenant, deviceId, input) {
      // Validate the bounded opaque request before durable capability admission
      // or receipt/mailbox allocation. A malformed control can therefore never
      // leave an immutable desired fact or delivery row behind.
      const payload = AgentHomeProjectionPayloadSchema.parse(input);
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('agent.home.projection', payload));
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const requestBody = JSON.stringify(payload);
      const persisted = await stores.receipts.record({
        key: agentHomeProjectionRequestKey(deviceId, payload.agentRef, payload.requestId),
        body: requestBody,
      });
      const persistedPayload = AgentHomeProjectionPayloadSchema.parse(JSON.parse(persisted.receipt.body));
      if (!sameAgentHomeProjectionRequest(payload, persistedPayload)) {
        throw new ByokCloudError(
          'agent_home_projection_request_conflict',
          `Agent-home projection request ${payload.requestId} already exists with a different immutable desired body.`,
        );
      }
      const messageId = await agentControlEnvelopeId(
        'byok:agent-home-projection',
        tenant,
        deviceId,
        payload.agentRef,
        payload.requestId,
      );
      const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
        createEnvelope('agent.home.projection', payload, { id: messageId, seq }),
      );
      if (
        control.envelope.type !== 'agent.home.projection' ||
        !sameAgentHomeProjectionRequest(payload, control.envelope.payload)
      ) {
        throw new ByokCloudError(
          'agent_home_projection_request_conflict',
          `Mailbox request ${payload.requestId} does not match its immutable Agent-home projection fact.`,
        );
      }
      const status = await getAgentHomeProjectionStatus(tenant, deviceId, {
        requestId: payload.requestId,
        agentRef: payload.agentRef,
        projectionHash: payload.projectionHash,
      });
      if (status === undefined) {
        throw new ByokCloudError(
          'agent_home_projection_receipt_invalid',
          `Agent-home projection request ${payload.requestId} disappeared after durable allocation.`,
        );
      }
      return { ...control, status };
    },

    async enqueueInputPreparation(tenant, deviceId, input) {
      // Validate the strict control body BEFORE durable capability admission or
      // any receipt/mailbox allocation, so a malformed request can never leave
      // an immutable desired fact or a delivery row behind.
      const payload = AgentInputPreparationPayloadSchema.parse(input);
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('agent.input.preparation', payload));
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const requestBody = JSON.stringify(payload);
      const persisted = await stores.receipts.record({
        key: inputPreparationRequestKey(deviceId, payload.agentRef, payload.requestId),
        body: requestBody,
      });
      const persistedPayload = AgentInputPreparationPayloadSchema.parse(JSON.parse(persisted.receipt.body));
      if (!sameInputPreparationRequest(payload, persistedPayload)) {
        throw new ByokCloudError(
          'input_preparation_request_conflict',
          `Input-preparation request ${payload.requestId} already exists with a different immutable desired body.`,
        );
      }
      // The mailbox message id is DERIVED from the logical request identity, so
      // a retried enqueue under the same requestId reuses the existing row
      // instead of appending a second delivery of the same desired fact.
      const messageId = await agentControlEnvelopeId(
        'byok:agent-input-preparation',
        tenant,
        deviceId,
        payload.agentRef,
        payload.requestId,
      );
      const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
        createEnvelope('agent.input.preparation', payload, { id: messageId, seq }),
      );
      if (
        control.envelope.type !== 'agent.input.preparation' ||
        !sameInputPreparationRequest(payload, control.envelope.payload)
      ) {
        throw new ByokCloudError(
          'input_preparation_request_conflict',
          `Mailbox request ${payload.requestId} does not match its immutable input-preparation fact.`,
        );
      }
      const status = await getInputPreparationStatus(tenant, deviceId, {
        requestId: payload.requestId,
        agentRef: payload.agentRef,
      });
      if (status === undefined) {
        throw new ByokCloudError(
          'input_preparation_receipt_invalid',
          `Input-preparation request ${payload.requestId} disappeared after durable allocation.`,
        );
      }
      return { ...control, status };
    },

    async enqueueProviderProvisioningNotice(tenant, deviceId, input) {
      // Strict one-field body first: an extra field (ciphertext, config,
      // identity) is a validation failure here, before any admission read or
      // mailbox allocation, never a stripped-and-sent notice.
      const payload = ProviderProvisioningAvailablePayloadSchema.parse(input);
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('provider.provisioning.available', payload));
      const messageId = uuidFromSha256(
        await options.crypto.sha256(
          new TextEncoder().encode(
            JSON.stringify({
              domain: 'byok:provider-provisioning-notice',
              tenant,
              deviceId,
              requestId: payload.requestId,
            }),
          ),
        ),
      );
      const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
        createEnvelope('provider.provisioning.available', payload, { id: messageId, seq }),
      );
      if (
        control.envelope.type !== 'provider.provisioning.available' ||
        control.envelope.payload.requestId !== payload.requestId
      ) {
        throw new ByokCloudError(
          'mailbox_receipt_mismatch',
          `Mailbox message ${messageId} does not carry provider provisioning notice ${payload.requestId}.`,
        );
      }
      return control;
    },

    async enqueueAgentMemoryIntentNotice(tenant, deviceId, input) {
      // Strict two-field body first: an extra field (path, operation,
      // revision, content) is a validation failure here, before any admission
      // read or mailbox allocation, never a stripped-and-sent notice.
      const payload = AgentMemoryIntentAvailablePayloadSchema.parse(input);
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('agent.memory.intent.available', payload));
      const messageId = uuidFromSha256(
        await options.crypto.sha256(
          new TextEncoder().encode(
            JSON.stringify({
              domain: 'byok:agent-memory-intent-notice',
              tenant,
              deviceId,
              intentId: payload.intentId,
            }),
          ),
        ),
      );
      const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
        createEnvelope('agent.memory.intent.available', payload, { id: messageId, seq }),
      );
      if (
        control.envelope.type !== 'agent.memory.intent.available' ||
        control.envelope.payload.intentId !== payload.intentId ||
        control.envelope.payload.agentRef.agentId !== payload.agentRef.agentId ||
        control.envelope.payload.agentRef.profileRevision !== payload.agentRef.profileRevision
      ) {
        throw new ByokCloudError(
          'mailbox_receipt_mismatch',
          `Mailbox message ${messageId} does not carry Agent memory intent notice ${payload.intentId} for this Agent.`,
        );
      }
      return control;
    },
  };
}
