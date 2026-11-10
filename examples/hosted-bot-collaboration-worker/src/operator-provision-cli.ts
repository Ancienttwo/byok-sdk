#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createByokPool, PostgresQuotaStore } from '@byok-sdk/cloud-dataplane';
import { isTenantId } from '@byok-sdk/cloud';
import type { HostConfig } from '@byok-sdk/example-hosted-bot-collaboration/src/index';
import { provisionEntitlement, provisionScope } from './operator-provision';

const usage = `Usage:
  node --import tsx src/operator-provision-cli.ts scope <scope> --owner <principal-id> --config <host-config.json>
  node --import tsx src/operator-provision-cli.ts entitlement <tenant>
Requires DATABASE_URL (SDK schema selected by the role's search_path); scope also requires HOST_SCHEMA.
Existing entitlements are preserved. Reprovisioning a scope rotates its owner token.`;

class ValidationError extends Error {}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const scopeCommand = args.length === 6 && args[0] === 'scope' && args[2] === '--owner' && args[4] === '--config';
  const entitlementCommand = args.length === 2 && args[0] === 'entitlement';
  if ((!scopeCommand && !entitlementCommand) || !args[1] || args[1].startsWith('-')
    || (scopeCommand && (!args[3] || args[3].startsWith('-') || !args[5] || args[5].startsWith('-')))) {
    throw new ValidationError('Invalid arguments. Use --help for usage.');
  }
  if (!isTenantId(args[1])) throw new ValidationError('Invalid scope or tenant identifier.');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new ValidationError('DATABASE_URL is required.');
  try {
    if (!['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol)) throw new Error();
  } catch { throw new ValidationError('DATABASE_URL must be a Postgres URL.'); }
  const schema = process.env.HOST_SCHEMA;
  if (scopeCommand && (!schema || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema))) throw new ValidationError('HOST_SCHEMA must be a valid schema name.');
  let config: HostConfig | undefined;
  if (scopeCommand) {
    try {
      config = JSON.parse(await readFile(args[5]!, 'utf8')) as HostConfig;
      if (!config || typeof config !== 'object' || !config.models || typeof config.models !== 'object' || Array.isArray(config.models)) throw new Error();
    } catch { throw new ValidationError('Cannot read a Host config JSON object with models.'); }
  }
  const pool = createByokPool({ connectionString, max: 1 });
  try {
    const core = { quota: new PostgresQuotaStore(pool, { now: () => new Date() }) };
    if (scopeCommand) console.log(await provisionScope(core, pool, schema!, args[1]!, { id: args[3]!, kind: 'human' }, config!));
    else await provisionEntitlement(core, args[1]!);
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  // Database and filesystem errors can contain credentials or input. Only print fixed validation errors.
  const message = error instanceof ValidationError ? error.message : 'Provisioning failed; check the database and schema.';
  console.error(message);
  process.exitCode = 1;
});
