import { beforeEach, vi } from 'vitest';
import { resetTestDeviceCredentials } from './fixtures/credential-backend';

// This is the unit-suite composition root. The production provider, including
// its native tests and fake-command tests, remains the real implementation.
vi.mock('../daemon/device-credential-provider', async () => {
  const { testDeviceCredentials, testDeviceMemberCustody } = await import('./fixtures/credential-backend');
  return {
    createDeviceCredentialStore: ({ productId }: { productId: string }) => testDeviceCredentials(productId),
    createDeviceMemberCustody: ({ productId }: { productId: string }) => testDeviceMemberCustody(productId),
  };
});

beforeEach(resetTestDeviceCredentials);
