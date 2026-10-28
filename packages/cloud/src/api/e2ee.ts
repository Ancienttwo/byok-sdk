import type { ByokCloud } from '../cloud';
import { type TenantId } from '@byok-sdk/core';
import * as e2eeMember from '../e2ee-member';

interface Dependencies {
  e2eeMemberContext: (tenant: TenantId) => e2eeMember.E2eeMemberContext;
}

export function createE2eeApi({ e2eeMemberContext }: Dependencies): Pick<ByokCloud,
  | 'appendMemberChainEntries'
  | 'readMemberChain'
  | 'putScopeKeyPackages'
  | 'readScopeKeyPackages'
  | 'readMemberKeyRegistration'
  | 'relayClientPairingMac'
> {
  return {
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
