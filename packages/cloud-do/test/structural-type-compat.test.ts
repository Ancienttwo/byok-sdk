import { expectTypeOf, it } from 'vitest';
import type { ModelProviderSecretName as KeysSecretName, ModelProviderVendorId, SecretStore } from '@byok-sdk/keys';
import type { DurableStorageFactory } from '../../client/src/adapters/pi-durable/storage';
import { openDurableObjectStorage } from '../src/storage';
import { platformCredentialReader, type ModelProviderSecretName, type PlatformCredentialReader, type PlatformProfile } from '../src/platform-credentials';

it('keeps the local storage factory equal to the client construction contract', () => {
  expectTypeOf<typeof openDurableObjectStorage>().toEqualTypeOf<DurableStorageFactory<DurableObjectStorage>>();
});

it('keeps the platform reader equal to the keys read contract', () => {
  expectTypeOf<ModelProviderSecretName>().toEqualTypeOf<KeysSecretName>();
  expectTypeOf<PlatformCredentialReader>().toEqualTypeOf<Pick<SecretStore<KeysSecretName>, 'get'>>();
  expectTypeOf<ReturnType<typeof platformCredentialReader>>().toExtend<PlatformCredentialReader>();
});

it('keeps the supported platform vendors inside the keys catalog', () => {
  expectTypeOf<PlatformProfile['vendor']>().toExtend<ModelProviderVendorId>();
});
