import { randomBytes } from 'node:crypto';
import { tenantId } from '@byok-sdk/cloud';
import type { CoreStores } from '@byok-sdk/core';
import type { Pool } from 'pg';
import type { Principal } from '@byok-sdk/bot-collaboration/host-kit';
import type { HostConfig } from '@byok-sdk/example-hosted-bot-collaboration/src/index';
import { sha256Hex, writeHostScope } from './host-scopes';

/** Provision the example quota once; preserve an existing entitlement and its limits. */
export async function provisionEntitlement(core: Pick<CoreStores, 'quota'>, scope: string): Promise<void> {
  const tenant = tenantId(scope);
  if (await core.quota.readEntitlement(tenant)) return;
  await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
    maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
}

/** Reprovisioning a scope rotates its owner token; only the hash is stored. */
export async function provisionScope(core: Pick<CoreStores, 'quota'>, pool: Pool, schema: string,
  scope: string, owner: Principal, config: HostConfig): Promise<string> {
  await provisionEntitlement(core, scope);
  const token = randomBytes(24).toString('hex');
  await writeHostScope(pool, schema, { scope, ownerTokenSha256: await sha256Hex(token), owner, config });
  return token;
}
