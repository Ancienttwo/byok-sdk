import {
  sealProviderProvisioningRequest,
  type ProviderProvisioningExpectedProfile,
  type ProviderProvisioningRequestV1,
} from '@byok-sdk/core';

import type { DeviceSealingKey } from '../device-sealing-key';
import { PI_MODEL_FIXTURE } from './pi-model-config';

export const TENANT = 'tenant-s1';
export const DEVICE = 'device-s1';
export const AGENT = '4f7c2d1e-9a3b-4c5d-8e6f-0a1b2c3d4e5f';
export const PROFILE_REF = 'salesko-4f7c2d1e9a3b4c5d8e6f0a1b2c3d4e5f';
export const ISSUED_AT = '2026-09-28T05:00:00.000Z';
export const EXPIRES_AT = '2026-09-28T05:15:00.000Z';
export const NOW = '2026-09-28T05:01:00.000Z';

export interface RequestOptions {
  readonly requestId: string;
  readonly generation: number;
  readonly expected?: ProviderProvisioningExpectedProfile;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly tenantId?: string;
  readonly deviceId?: string;
  readonly agentId?: string;
}

function header(options: RequestOptions, operation: 'configure' | 'update_model' | 'replace_secret' | 'delete') {
  return {
    tenantId: options.tenantId ?? TENANT,
    deviceId: options.deviceId ?? DEVICE,
    agentId: options.agentId ?? AGENT,
    requestId: options.requestId,
    operation,
    operationGeneration: options.generation,
    expectedProfile: options.expected ?? null,
    issuedAt: options.issuedAt ?? ISSUED_AT,
    expiresAt: options.expiresAt ?? EXPIRES_AT,
  };
}

export function configureRequest(
  key: DeviceSealingKey,
  secret: string,
  options: RequestOptions & { providerKind?: string; modelId?: string; piModel?: object; capabilities?: string[] },
): Promise<ProviderProvisioningRequestV1> {
  return sealProviderProvisioningRequest({
    header: header(options, 'configure'),
    config: {
      operation: 'configure',
      agentId: options.agentId ?? AGENT,
      providerKind: options.providerKind ?? 'zai',
      modelId: options.modelId ?? 'glm-5.3-flash',
      piModel: (options.piModel ?? PI_MODEL_FIXTURE) as never,
      capabilities: options.capabilities ?? [],
    },
    recipient: { keyId: key.keyId, publicJwk: key.publicJwk },
    secret,
  });
}

export function updateModelRequest(
  options: RequestOptions & { providerKind?: string; modelId: string },
): Promise<ProviderProvisioningRequestV1> {
  return sealProviderProvisioningRequest({
    header: header(options, 'update_model'),
    config: {
      operation: 'update_model',
      agentId: options.agentId ?? AGENT,
      providerKind: options.providerKind ?? 'zai',
      modelId: options.modelId,
      piModel: PI_MODEL_FIXTURE as never,
      capabilities: [],
    },
  });
}

export function replaceSecretRequest(
  key: DeviceSealingKey,
  secret: string,
  options: RequestOptions & { providerKind?: string },
): Promise<ProviderProvisioningRequestV1> {
  return sealProviderProvisioningRequest({
    header: header(options, 'replace_secret'),
    config: { operation: 'replace_secret', agentId: options.agentId ?? AGENT, providerKind: options.providerKind ?? 'zai' },
    recipient: { keyId: key.keyId, publicJwk: key.publicJwk },
    secret,
  });
}

export function deleteRequest(options: RequestOptions): Promise<ProviderProvisioningRequestV1> {
  return sealProviderProvisioningRequest({
    header: header(options, 'delete'),
    config: { operation: 'delete', agentId: options.agentId ?? AGENT },
  });
}
