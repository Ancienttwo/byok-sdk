/**
 * The custody child: the Host executable re-entered with `CUSTODY_COMMAND`.
 * It reads one request from stdin, writes the provider profile and the OS
 * credential through `ProviderRegistry`, prints one secret-free receipt line
 * and exits. Only this process and main ever hold the secret.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  ByokKeysError, inspectProviderProfileStore, ProviderProfileRefSchema, ProviderRegistry, SqliteProviderProfileStore,
  type ModelProviderSecretName, type ProviderConfiguration, type ProviderStatus, type SecretStore,
} from '@byok-sdk/keys';
import { CustodyError, type CustodyReceipt, type CustodyRequest } from './protocol.ts';

const REQUEST_MAX_BYTES = 64 * 1024;

async function readRequest(input: Readable): Promise<CustodyRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += (chunk as Buffer).length;
    if (size > REQUEST_MAX_BYTES) throw new CustodyError('custody_request_invalid', `Request exceeds ${REQUEST_MAX_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // JSON.parse quotes the input in its message, and the input holds the secret.
    throw new CustodyError('custody_request_invalid', 'Request is not JSON');
  }
  return parseRequest(value);
}

function parseRequest(value: unknown): CustodyRequest {
  const request = value as Record<string, unknown> | null;
  const invalid = (reason: string) => new CustodyError('custody_request_invalid', reason);
  if (typeof request !== 'object' || request === null) throw invalid('Request must be an object');
  if (request.secret !== undefined && typeof request.secret !== 'string') throw invalid('secret must be a string');
  if (request.op === 'configure') {
    if (typeof request.configuration !== 'object' || request.configuration === null) throw invalid('configuration must be an object');
    return { op: 'configure', configuration: request.configuration as ProviderConfiguration,
      ...(request.secret === undefined ? {} : { secret: request.secret as string }) };
  }
  if (request.op === 'replace_secret') {
    if (typeof request.secret !== 'string') throw invalid('replace_secret requires a secret');
    return { op: 'replace_secret', profileRef: ProviderProfileRefSchema.parse(request.profileRef), secret: request.secret };
  }
  throw invalid('op must be configure or replace_secret');
}

/**
 * Applies one request to the keys store. The Host migrates that store before
 * any custody child starts, so any verdict but `accepted` or `absent` refuses.
 */
export async function runCustody(input: Readable, keysDb: string, secretStore: SecretStore<ModelProviderSecretName>): Promise<ProviderStatus> {
  const request = await readRequest(input);
  const store = await inspectProviderProfileStore(keysDb);
  if (store.verdict !== 'accepted' && store.verdict !== 'absent') {
    throw new CustodyError('keys_store_refused', `Keys store at ${keysDb} is ${store.verdict}: ${store.reason}`);
  }
  await mkdir(path.dirname(keysDb), { recursive: true, mode: 0o700 });
  const registry = new ProviderRegistry({ profileStore: new SqliteProviderProfileStore({ path: keysDb }), secretStore });
  try {
    return request.op === 'configure'
      ? await registry.configure(request.configuration, request.secret)
      : await registry.replaceSecret(request.profileRef, request.secret);
  } finally {
    await registry.close();
  }
}

/** The receipt for a refusal: codes and messages only, never the request. */
export function refusalReceipt(error: unknown): CustodyReceipt {
  if (error instanceof CustodyError || error instanceof ByokKeysError) return { ok: false, code: error.code, message: error.message };
  return { ok: false, code: 'custody_failed', message: error instanceof Error ? error.message : String(error) };
}

/** The re-entered command: one receipt line on stdout; exit 0 only when the change committed. */
export async function runCustodyCommand(keysDb: string, secretStore: () => SecretStore<ModelProviderSecretName>): Promise<number> {
  let receipt: CustodyReceipt;
  try {
    receipt = { ok: true, status: await runCustody(process.stdin, keysDb, secretStore()) };
  } catch (error) {
    receipt = refusalReceipt(error);
  }
  await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(receipt)}\n`, error => (error ? reject(error) : resolve())));
  return receipt.ok ? 0 : 1;
}
