#!/usr/bin/env node
import {
  ConnectorBrokerError,
  GmailConnectorBroker,
} from '../broker';
import { GoogleGmailReadProvider } from '../google-gmail-provider';
import {
  GoogleOAuthAccessTokenSource,
  authorizeGoogleGmailWithLoopback,
  configureGoogleOAuthClient,
  forgetGoogleOAuthConnection,
  readGoogleOAuthStatus,
  revokeGoogleOAuthConnection,
} from '../google-oauth';
import { serveConnectorMcp } from '../mcp-server';
import { createSaleskoConnectorSecretStore } from '../platform-store';

const MAX_CONFIGURATION_BYTES = 8 * 1024;

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
    if (bytes > MAX_CONFIGURATION_BYTES) {
      throw new ConnectorBrokerError('CREDENTIAL_INVALID', 'OAuth client input exceeds the byte limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new ConnectorBrokerError('CONFIG_INVALID', 'a connector broker command is required');
  const store = createSaleskoConnectorSecretStore();

  if (command === 'configure') {
    assertKnownOptions(args, new Set(['--profile']));
    const profileId = singleOption(args, '--profile');
    let client: unknown;
    try {
      client = JSON.parse(await readBoundedStdin());
    } catch (error) {
      if (error instanceof ConnectorBrokerError) throw error;
      throw new ConnectorBrokerError('CREDENTIAL_INVALID', 'OAuth client input is not valid JSON');
    }
    await configureGoogleOAuthClient(store, profileId, client);
    process.stdout.write(`${JSON.stringify({ ok: true, profileId, client: 'configured' })}\n`);
    return;
  }

  if (command === 'login') {
    assertKnownOptions(args, new Set(['--profile']));
    const profileId = singleOption(args, '--profile');
    const status = await authorizeGoogleGmailWithLoopback({
      store,
      profileId,
      onAuthorizationUrl(url) {
        process.stderr.write(`Open this URL in your default browser to authorize Gmail read-only access:\n${url}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({ profileId, ...status })}\n`);
    return;
  }

  if (command === 'revoke') {
    assertKnownOptions(args, new Set(['--profile']));
    const profileId = singleOption(args, '--profile');
    const removed = await revokeGoogleOAuthConnection({ store, profileId });
    process.stdout.write(`${JSON.stringify({ ok: true, profileId, removed })}\n`);
    return;
  }

  if (command === 'forget') {
    assertKnownOptions(args, new Set(['--profile']));
    const profileId = singleOption(args, '--profile');
    const removed = await forgetGoogleOAuthConnection(store, profileId);
    process.stdout.write(`${JSON.stringify({ ok: true, profileId, removed, upstreamRevoked: false })}\n`);
    return;
  }

  if (command === 'status') {
    assertKnownOptions(args, new Set(['--profile']));
    const profileId = singleOption(args, '--profile');
    const status = await readGoogleOAuthStatus(store, profileId);
    process.stdout.write(`${JSON.stringify({ profileId, ...status })}\n`);
    return;
  }

  if (command === 'serve') {
    assertKnownOptions(args, new Set(['--profile', '--allow-domain']));
    const profileId = singleOption(args, '--profile');
    const allowedDomains = optionValues(args, '--allow-domain');
    if (allowedDomains.length === 0) {
      throw new ConnectorBrokerError('CONFIG_INVALID', 'at least one --allow-domain is required');
    }
    const broker = new GmailConnectorBroker({
      profileId,
      policy: { allowedDomains },
      tokenSource: new GoogleOAuthAccessTokenSource(store),
      provider: new GoogleGmailReadProvider(),
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
