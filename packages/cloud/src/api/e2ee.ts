import type { ByokCloud, ByokCloudOptions, EnqueuedAgentControl } from '../cloud';
import { type TenantId } from '@byok-sdk/core';
import {
  E2eeKeyPackageAvailablePayloadSchema,
  createEnvelope,
  requiredReceiverCapabilities,
  type E2eeKeyPackageAvailablePayload,
} from '@byok-sdk/protocol';
import * as e2eeMember from '../e2ee-member';
import { ByokCloudError } from '../errors';
import { uuidFromSha256 } from '../offer-identity';
import type { EnqueuePaths } from './enqueue';

interface Dependencies {
  options: ByokCloudOptions;
  assertAgentCapabilities: EnqueuePaths['assertAgentCapabilities'];
  enqueueAgentControlEnvelope: EnqueuePaths['enqueueAgentControlEnvelope'];
}

/** The Host E2EE member API, plus the tenant-bound member context the E2EE device routes use. */
export function createE2eeApi({ options, assertAgentCapabilities, enqueueAgentControlEnvelope }: Dependencies): Pick<ByokCloud,
  | 'appendMemberChainEntries'
  | 'readMemberChain'
  | 'putScopeKeyPackages'
  | 'readScopeKeyPackages'
  | 'readMemberKeyRegistration'
  | 'relayClientPairingMac'
  | 'enqueueScopeKeyPackageNotice'
> & {
  e2eeMemberContext: (tenant: TenantId) => e2eeMember.E2eeMemberContext;
} {
  function e2eeMemberContext(tenant: TenantId): e2eeMember.E2eeMemberContext {
    const store = options.e2eeMemberStore;
    if (store === undefined) {
      throw new ByokCloudError('e2ee_member_store_unavailable', 'E2EE member storage is not configured for this deployment.');
    }
    return {
      store,
      tenant,
      devices: options.cloud.devices,
      now: () => options.clock.now(),
      enqueueKeyPackageNotice: (deviceId, payload) => enqueueScopeKeyPackageNotice(tenant, deviceId, payload),
    };
  }

  async function enqueueScopeKeyPackageNotice(
    tenant: TenantId,
    deviceId: string,
    input: E2eeKeyPackageAvailablePayload,
  ): Promise<EnqueuedAgentControl> {
    const payload = E2eeKeyPackageAvailablePayloadSchema.parse(input);
    await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('e2ee.key_package.available', payload));
    const messageId = uuidFromSha256(
      await options.crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify({ domain: 'byok:e2ee-key-package-notice', tenant, deviceId, scopeId: payload.scopeId, epoch: payload.epoch }),
        ),
      ),
    );
    const control = await enqueueAgentControlEnvelope(tenant, deviceId, messageId, (seq) =>
      createEnvelope('e2ee.key_package.available', payload, { id: messageId, seq }),
    );
    if (
      control.envelope.type !== 'e2ee.key_package.available' ||
      control.envelope.payload.scopeId !== payload.scopeId ||
      control.envelope.payload.epoch !== payload.epoch
    ) {
      throw new ByokCloudError(
        'mailbox_receipt_mismatch',
        `Mailbox message ${messageId} does not carry the key package notice for scope ${payload.scopeId} epoch ${payload.epoch}.`,
      );
    }
    return control;
  }

  return {
    e2eeMemberContext,
    enqueueScopeKeyPackageNotice,

    async appendMemberChainEntries(tenant, input) {
      return e2eeMember.appendMemberChainEntries(e2eeMemberContext(tenant), input, { kind: 'host' });
    },

    async readMemberChain(tenant, input) {
      return e2eeMember.readMemberChain(e2eeMemberContext(tenant), input);
    },

    async putScopeKeyPackages(tenant, input) {
      return e2eeMember.putScopeKeyPackages(e2eeMemberContext(tenant), input, { kind: 'host' });
    },

    async readScopeKeyPackages(tenant, input) {
      return e2eeMember.readScopeKeyPackages(e2eeMemberContext(tenant), input);
    },

    async readMemberKeyRegistration(tenant, deviceId) {
      return e2eeMember.readMemberKeyRegistration(e2eeMemberContext(tenant), deviceId);
    },

    async relayClientPairingMac(tenant, deviceId, input) {
      return e2eeMember.relayClientPairingMac(e2eeMemberContext(tenant), deviceId, input);
    },
  };
}
