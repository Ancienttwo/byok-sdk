import type { ByokCloud, ByokCloudOptions } from '../cloud';
import { type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import { assertBoardLabels, DEFAULT_BOARD_CHANNEL_MAX_BYTES, DEFAULT_BOARD_TITLE_MAX_BYTES } from '../coordination';
import { tenantStoresFor, type CloudRootStores } from '../tenant-stores';

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
}

export function createTenantApi({ root, controlPlane, options }: Dependencies): Pick<ByokCloud,
  | 'listDevices'
  | 'revokeDevice'
  | 'createBoardItem'
  | 'listBoardItems'
  | 'acceptBoardItem'
  | 'listPresence'
  | 'readTenantReadiness'
> {
  return {
    listDevices(tenant) {
      return tenantStoresFor(controlPlane(tenant), root).devices.list();
    },

    revokeDevice(tenant, deviceId) {
      return tenantStoresFor(controlPlane(tenant), root).devices.revoke(deviceId);
    },

    createBoardItem(tenant, input) {
      assertBoardLabels(input.channel, input.title, {
        channelMaxBytes: options.boardChannelMaxBytes ?? DEFAULT_BOARD_CHANNEL_MAX_BYTES,
        titleMaxBytes: options.boardTitleMaxBytes ?? DEFAULT_BOARD_TITLE_MAX_BYTES,
      });
      return tenantStoresFor(controlPlane(tenant), root).board.create(input);
    },

    listBoardItems(tenant, query) {
      return tenantStoresFor(controlPlane(tenant), root).board.list(query);
    },

    acceptBoardItem(tenant, itemId) {
      return tenantStoresFor(controlPlane(tenant), root).board.updateStatus({
        itemId,
        expectedStatus: 'in_review',
        status: 'done',
      });
    },

    listPresence(tenant) {
      return tenantStoresFor(controlPlane(tenant), root).presence.list();
    },

    readTenantReadiness(tenant) {
      return tenantStoresFor(controlPlane(tenant), root).devices.readiness();
    },
  };
}
