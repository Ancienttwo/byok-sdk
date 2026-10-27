import type { ByokCloud, ByokCloudOptions } from '../cloud';
import { readTaskAgentMessageDraft } from '../agent-message-draft';
import { readTaskAgentMessage } from '../task-agent-message';
import { taskOfferMessageId } from '../offer-identity';
import { type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import { AgentMessagePublishPayloadSchema, TaskOfferPayloadSchema, type AgentRef } from '@byok-sdk/protocol';
import { ByokCloudError } from '../errors';
import { readAgentMessageDisposition, terminalReceiptKey } from '../inbound';
import { projectTerminalResult, readDeviceTerminalReceipt } from '../terminal-result';
import { assertTaskContentPresent } from '../task-redaction';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
  sameAgentRef: (expected: AgentRef, actual: AgentRef | undefined) => boolean;
}

export function createTaskReadsApi({ root, controlPlane, options, sameAgentRef }: Dependencies): Pick<ByokCloud,
  | 'readTaskOffer'
  | 'readTaskAttempt'
  | 'listTaskAttempts'
  | 'countTaskAttempts'
  | 'readTerminalReceipt'
  | 'readDeviceTerminal'
  | 'readTaskAgentMessageDraft'
  | 'readTaskAgentMessage'
  | 'readAgentMessageDisposition'
  | 'readAgentEgress'
  | 'readTaskResult'
  | 'readActivity'
  | 'readApprovalTimeline'
> {
  return {
    async readTaskOffer(tenant, taskId) {
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const attempt = await stores.tasks.get(taskId);
      if (attempt === undefined) return undefined;
      const messageId = await taskOfferMessageId(tenant, taskId, attempt.deviceId, attempt.agentRef, bytes => options.crypto.sha256(bytes));
      const receipt = await stores.receipts.get(`task-offer:${messageId}`);
      if (receipt === undefined) return undefined;
      assertTaskContentPresent(taskId, receipt.body);
      const invalid = () => new ByokCloudError('coordination_input_invalid', `Task ${taskId} has an unreadable or mismatched immutable offer receipt.`);
      let stored: { deviceId?: unknown; type?: unknown; payload?: unknown };
      try { stored = JSON.parse(receipt.body); } catch { throw invalid(); }
      if (stored === null || typeof stored !== 'object' || stored.deviceId !== attempt.deviceId ||
          stored.type !== 'task.offer') throw invalid();
      const parsed = TaskOfferPayloadSchema.safeParse(stored.payload);
      if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(stored.payload)) throw invalid();
      if (attempt.agentRef === undefined || !sameAgentRef(parsed.data.agentRef, attempt.agentRef)) throw invalid();
      const delivered = await stores.receipts.get(`task-offer-delivered:${messageId}`);
      if (delivered !== undefined && delivered.body !== messageId) throw invalid();
      return { taskId, deviceId: attempt.deviceId, messageId, type: 'task.offer', payload: parsed.data,
        recordedAt: receipt.recordedAt, delivered: delivered !== undefined };
    },

    readTaskAttempt(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).tasks.get(taskId);
    },

    listTaskAttempts(tenant, query) {
      return tenantStoresFor(controlPlane(tenant), root).tasks.list(query);
    },

    countTaskAttempts(tenant) {
      return tenantStoresFor(controlPlane(tenant), root).tasks.countByStatus();
    },

    async readTerminalReceipt(tenant, taskId) {
      const receipt = await tenantStoresFor(controlPlane(tenant), root).receipts.get(terminalReceiptKey(taskId));
      if (receipt !== undefined) assertTaskContentPresent(taskId, receipt.body);
      return receipt;
    },

    async readDeviceTerminal(tenant, taskId) {
      const receipt = await tenantStoresFor(controlPlane(tenant), root).receipts.get(terminalReceiptKey(taskId));
      return receipt === undefined ? undefined : readDeviceTerminalReceipt(taskId, receipt);
    },

    readTaskAgentMessageDraft(tenant, deviceId, taskId, agentRef, cursor) {
      return readTaskAgentMessageDraft(tenantStoresFor(controlPlane(tenant), root), deviceId, taskId, agentRef, cursor);
    },

    readTaskAgentMessage(tenant, deviceId, taskId, agentRef) {
      return readTaskAgentMessage(tenantStoresFor(controlPlane(tenant), root), deviceId, taskId, agentRef);
    },

    async readAgentMessageDisposition(tenant, deviceId, taskId, payload) {
      const parsed = AgentMessagePublishPayloadSchema.parse(payload);
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const disposition = await readAgentMessageDisposition(stores, deviceId, taskId, parsed);
      if (disposition !== undefined) return disposition;
      const admission = await stores.tasks.readTaskAgentMessage({ taskId, deviceId });
      if (admission !== undefined) assertTaskContentPresent(taskId, admission.payloadBody);
      return undefined;
    },

    readAgentEgress(tenant, deviceId, agentRef, eventId) {
      return tenantStoresFor(controlPlane(tenant), root).egress.get(deviceId, agentRef, eventId);
    },

    async readTaskResult(tenant, taskId) {
      const stores = tenantStoresFor(controlPlane(tenant), root);
      const attempt = await stores.tasks.get(taskId);
      if (attempt?.cancellation !== undefined) {
        return {
          taskId,
          state: 'cancelled',
          ...(attempt.agentRef === undefined ? {} : { agentRef: attempt.agentRef }),
          ...(attempt.cancellation.reason === undefined
            ? {}
            : { reason: attempt.cancellation.reason }),
          ...(attempt.cancellation.reason === undefined
            ? {}
            : { terminalCause: attempt.cancellation.reason }),
          recordedAt: attempt.cancellation.requestedAt,
        };
      }
      const receipt = await stores.receipts.get(
        terminalReceiptKey(taskId),
      );
      return receipt === undefined ? undefined : projectTerminalResult(taskId, receipt);
    },

    readActivity(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).activity.read(taskId);
    },

    readApprovalTimeline(tenant, taskId) {
      return tenantStoresFor(controlPlane(tenant), root).approvals.read(taskId);
    },
  };
}
