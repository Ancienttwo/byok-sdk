import type { ByokCloud, ByokCloudOptions, AgentHomeProjectionStatusInput, InputPreparationStatusInput } from '../cloud';
import { type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import {
  AGENT_HOME_PROJECTION_CAPABILITY,
  AgentHomeProjectionCompletionRequestSchema,
  InputPreparationCompletionRequestSchema,
  type AgentHomeProjectionCompletionRequest,
  type AgentHomeProjectionReadback,
  type InputPreparationCompletionRequest,
  type InputPreparationReadback,
} from '@byok-sdk/protocol';
import { readAgentHomeProjectionStatus, recordAgentHomeProjectionCompletion } from '../agent-home-projections';
import { readInputPreparationStatus, recordInputPreparationCompletion } from '../input-preparations';
import { tenantStoresFor, type CloudRootStores, type TenantStores } from '../tenant-stores';
import type { EnqueuePaths } from './enqueue';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
  assertAgentCapabilities: EnqueuePaths['assertAgentCapabilities'];
  /** The public `AGENT_HOME_CONTRACT_CAPABILITY`, owned by `cloud.ts`. */
  agentHomeContractCapability: string;
}

/** The Host projection-receipt reads and completions, plus the store-bound completions the device routes call. */
export function createProjectionReceiptsApi({
  root,
  controlPlane,
  options,
  assertAgentCapabilities,
  agentHomeContractCapability,
}: Dependencies): Pick<ByokCloud,
  | 'getAgentHomeProjectionStatus'
  | 'completeAgentHomeProjection'
  | 'getInputPreparationStatus'
  | 'completeInputPreparation'
> & {
  completeAgentHomeProjectionFromStores: (stores: TenantStores, deviceId: string, receiptInput: AgentHomeProjectionCompletionRequest) => Promise<AgentHomeProjectionReadback>;
  completeInputPreparationFromStores: (stores: TenantStores, deviceId: string, receiptInput: InputPreparationCompletionRequest) => Promise<InputPreparationReadback>;
} {
  async function getAgentHomeProjectionStatus(
    tenant: TenantId,
    deviceId: string,
    input: AgentHomeProjectionStatusInput,
  ): Promise<AgentHomeProjectionReadback | undefined> {
    return readAgentHomeProjectionStatus(
      tenantStoresFor(controlPlane(tenant), root).receipts,
      tenant,
      deviceId,
      input,
    );
  }

  async function completeAgentHomeProjection(
    tenant: TenantId,
    deviceId: string,
    receiptInput: AgentHomeProjectionCompletionRequest,
  ): Promise<AgentHomeProjectionReadback> {
    return completeAgentHomeProjectionFromStores(
      tenantStoresFor(controlPlane(tenant), root),
      deviceId,
      receiptInput,
    );
  }

  async function completeAgentHomeProjectionFromStores(
    stores: TenantStores,
    deviceId: string,
    receiptInput: AgentHomeProjectionCompletionRequest,
  ): Promise<AgentHomeProjectionReadback> {
    const receipt = AgentHomeProjectionCompletionRequestSchema.parse(receiptInput);
    await assertAgentCapabilities(stores.tenant, deviceId, [
      agentHomeContractCapability,
      AGENT_HOME_PROJECTION_CAPABILITY,
    ]);
    const readback = await recordAgentHomeProjectionCompletion(
      stores.receipts,
      stores.tenant,
      deviceId,
      receipt,
    );
    try { options.observer?.onAgentHomeProjectionCompleted?.(readback); } catch { /* Observers cannot change durable completion. */ }
    return readback;
  }

  async function getInputPreparationStatus(
    tenant: TenantId,
    deviceId: string,
    input: InputPreparationStatusInput,
  ): Promise<InputPreparationReadback | undefined> {
    return readInputPreparationStatus(
      tenantStoresFor(controlPlane(tenant), root).receipts,
      tenant,
      deviceId,
      input,
    );
  }

  async function completeInputPreparation(
    tenant: TenantId,
    deviceId: string,
    receiptInput: InputPreparationCompletionRequest,
  ): Promise<InputPreparationReadback> {
    return completeInputPreparationFromStores(
      tenantStoresFor(controlPlane(tenant), root),
      deviceId,
      receiptInput,
    );
  }

  /**
   * Deliberately NOT capability-gated, unlike `enqueueInputPreparation`.
   *
   * Admission is the enqueue's job: a device without
   * `agent-input-preparation-v9` is refused there, before any receipt or mailbox
   * row exists. Once a row DOES exist, the completion is the device's only way
   * to discharge it, and the daemon's redelivery cursor advances only when the
   * completion PUT succeeds. Re-asserting the capability here would reject
   * exactly the completion an unconfigured device must be able to record —
   * `input_preparation_unconfigured` — and freeze that device's strictly
   * seq-ordered cursor behind an envelope with no terminal path.
   *
   * Authority does not weaken: the row's own binding (authenticated device,
   * exact `AgentRef`, `profileId`, `policyRevision`) is checked by
   * `recordInputPreparationCompletion`, so a completion still cannot cross a
   * device, an Agent, or a policy revision. The one authority reduction this
   * does accept, stated plainly: revoking `agent-input-preparation-v9` after a row
   * is enqueued no longer refuses the in-flight completion — that row was
   * legitimately admitted, its receipt stays not-ready and G4 is closed to
   * activation — so revocation stops NEW admissions only.
   *
   * "The device can always discharge its row" holds only within ONE contract
   * version. The completion body is parsed with the strict receipt schema of
   * THIS build, and the relay wire carries no version, so a row admitted
   * before the v5 cut and completed by a device on the other side of it is
   * rejected (422) and stalls that device's cursor. That boundary is an
   * operator precondition — drain in-flight rows, then upgrade cloud and
   * devices as a pair (`docs/spec.md`, bounded admission) — not something this
   * route translates.
   */
  async function completeInputPreparationFromStores(
    stores: TenantStores,
    deviceId: string,
    receiptInput: InputPreparationCompletionRequest,
  ): Promise<InputPreparationReadback> {
    const receipt = InputPreparationCompletionRequestSchema.parse(receiptInput);
    return recordInputPreparationCompletion(stores.receipts, stores.tenant, deviceId, receipt);
  }

  return {
    getAgentHomeProjectionStatus,
    completeAgentHomeProjection,
    completeAgentHomeProjectionFromStores,
    getInputPreparationStatus,
    completeInputPreparation,
    completeInputPreparationFromStores,
  };
}
