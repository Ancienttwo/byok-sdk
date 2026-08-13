#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GmailReadProvider } from '../broker';
import {
  ConnectorBrokerError,
  GmailConnectorBroker,
  SecretStoreOAuthAccessTokenSource,
  provisionOAuthCredential,
  readOAuthCredentialStatus,
  revokeOAuthCredential,
} from '../broker';
import { serveConnectorMcp } from '../mcp-server';
import { createSaleskoConnectorSecretStore } from '../platform-store';

const MAX_PROVISION_BYTES = 32 * 1024;

function optionValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new ConnectorBrokerError('CONFIG_INVALID', `missing value for ${name}`);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

function singleOption(args: readonly string[], name: string): string {
  const values = optionValues(args, name);
  if (values.length !== 1) {
    throw new ConnectorBrokerError('CONFIG_INVALID', `${name} must be supplied exactly once`);
  }
  return values[0] as string;
}

function assertKnownOptions(args: readonly string[], allowed: ReadonlySet<string>): void {
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name || !allowed.has(name) || args[index + 1] === undefined) {
      throw new ConnectorBrokerError('CONFIG_INVALID', 'connector broker command options are invalid');
    }
  }
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += buffer.length;
    if (bytes > MAX_PROVISION_BYTES) {
      throw new ConnectorBrokerError('CREDENTIAL_INVALID', 'OAuth credential input exceeds the byte limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadProvider(modulePath: string): Promise<GmailReadProvider> {
  if (!isAbsolute(modulePath)) {
    throw new ConnectorBrokerError('CONFIG_INVALID', '--provider-module must be an absolute local path');
  }
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(modulePath).href);
  } catch {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'the Gmail provider module could not be loaded');
  }
  if (
    typeof loaded !== 'object' ||
    loaded === null ||
    !('createGmailReadProvider' in loaded) ||
    typeof loaded.createGmailReadProvider !== 'function'
  ) {
    throw new ConnectorBrokerError(
      'CONFIG_INVALID',
      'the Gmail provider module must export createGmailReadProvider()',
    );
  }
  let provider: unknown;
  try {
    provider = await loaded.createGmailReadProvider();
  } catch {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'the Gmail provider module failed to initialize');
  }
  if (
    typeof provider !== 'object' ||
    provider === null ||
    !('searchCorrespondence' in provider) ||
    typeof provider.searchCorrespondence !== 'function'
  ) {
    throw new ConnectorBrokerError('CONFIG_INVALID', 'the Gmail provider module returned an invalid provider');
  }
  return provider as GmailReadProvider;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new ConnectorBrokerError('CONFIG_INVALID', 'a connector broker command is required');
  const store = createSaleskoConnectorSecretStore();

  if (command === 'provision') {
    assertKnownOptions(args, new Set(['--profile']));
    const profileId = singleOption(args, '--profile');
    let credential: unknown;
    try {
      credential = JSON.parse(await readBoundedStdin());
    } catch (error) {
      if (error instanceof ConnectorBrokerError) throw error;
      throw new ConnectorBrokerError('CREDENTIAL_INVALID', 'OAuth credential input is not valid JSON');
    }
    await provisionOAuthCredential(store, profileId, credential);
    process.stdout.write(`${JSON.stringify({ ok: true, profileId })}\n`);
    return;
  }

  if (command === 'revoke') {
    assertKnownOptions(args, new Set(['--profile']));
    const profileId = singleOption(args, '--profile');
    const removed = await revokeOAuthCredential(store, profileId);
    process.stdout.write(`${JSON.stringify({ ok: true, profileId, removed })}\n`);
    return;
  }

  if (command === 'status') {
    assertKnownOptions(args, new Set(['--profile']));
    const profileId = singleOption(args, '--profile');
    const status = await readOAuthCredentialStatus(store, profileId);
    process.stdout.write(`${JSON.stringify({ profileId, ...status })}\n`);
    return;
  }

  if (command === 'serve') {
    assertKnownOptions(args, new Set(['--profile', '--allow-domain', '--provider-module']));
    const profileId = singleOption(args, '--profile');
    const allowedDomains = optionValues(args, '--allow-domain');
    if (allowedDomains.length === 0) {
      throw new ConnectorBrokerError('CONFIG_INVALID', 'at least one --allow-domain is required');
    }
    const provider = await loadProvider(singleOption(args, '--provider-module'));
    const broker = new GmailConnectorBroker({
      profileId,
      policy: { allowedDomains },
      tokenSource: new SecretStoreOAuthAccessTokenSource(store),
      provider,
    });
    await serveConnectorMcp(broker);
    return;
  }

  throw new ConnectorBrokerError('CONFIG_INVALID', 'unknown connector broker command');
}

void main().catch((error) => {
  const message = error instanceof ConnectorBrokerError ? error.message : 'connector broker failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
