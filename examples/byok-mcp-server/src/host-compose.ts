// Copy-and-own Mode G Host: the embedded SDK server and the beta MCP endpoint on
// one loopback origin, for a Grok Bot custom MCP entry (docs/grok-bot.md).
//
//   bun run host -- [--state <dir>] [--issue-key] [--runtime pi|codex|claude]...
//   bun run host -- [--state <dir>] --revoke <keyId>     # with the Host stopped
//
// A device pairs with the printed `byok-agent pair` command. `--issue-key` waits
// for the first paired device, then issues one task-only Grok Bot key and prints
// its token once, inside the Grok Bot entry. The token is never logged again and
// never stored; the ledger keeps only its digest.
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createByokServer, listenLoopback, type ByokServer, type LoopbackPortStore } from '@byok-sdk/server';
import type { RuntimeId } from '@byok-sdk/protocol';
import { BetaLedger, createBetaMcpServer, createTaskTools, type KeyInfo, type KeySpec } from './index';

export const GROK_BOT_SCOPES: KeySpec['scopes'] = ['tasks.dispatch', 'tasks.read', 'tasks.cancel'];
const MCP_PATH = '/mcp';
// Device blob uploads use the same listener; match the SDK's default blob ceiling (100 MiB).
const MAX_BODY_BYTES = 100 * 1024 * 1024;

export interface HostOptions {
  /** Private directory for the SDK SQLite store, the beta ledger and the port assignment. */
  readonly stateDir: string;
  /** Must equal the paired daemon config's `productId`. */
  readonly productId?: string;
  readonly statusPollMs?: number;
}

/** First write wins; a later start reuses the port so a paired device keeps its server URL. */
function filePortStore(file: string): LoopbackPortStore {
  const read = async () => {
    try { return JSON.parse(readFileSync(file, 'utf8')).port as number; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  return {
    read,
    claim: async candidate => {
      try {
        const fd = openSync(file, 'wx', 0o600);
        try { writeSync(fd, JSON.stringify({ port: candidate })); } finally { closeSync(fd); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      return (await read())!;
    },
  };
}

/** The entry a Grok Bot owner pastes as a custom MCP server (remote shape, static bearer in `headers`). */
export function grokBotEntry(mcpUrl: string, token: string) {
  return { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } as const;
}

export async function startHost(options: HostOptions) {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const productId = options.productId ?? 'byok-mcp-host';
  const sdk: ByokServer = createByokServer({ productId, storage: { kind: 'sqlite', path: path.join(options.stateDir, 'byok.sqlite') } });
  const ledger = new BetaLedger(path.join(options.stateDir, 'beta.sqlite'), productId, { tasks: sdk.tasks });
  let endpoint: ReturnType<typeof createBetaMcpServer> | undefined;
  try {
    const listener = await listenLoopback({
      portStore: filePortStore(path.join(options.stateDir, 'port.json')),
      maxBodyBytes: MAX_BODY_BYTES,
      createHandler: origin => {
        endpoint = createBetaMcpServer({ ledger, origin, serverInfo: { name: 'byok-mcp-host', version: '1' },
          tools: createTaskTools({ sdk, ledger, blobBaseUrl: origin, ...(options.statusPollMs ? { statusPollMs: options.statusPollMs } : {}) }) });
        const mcp = endpoint;
        return request => new URL(request.url).pathname === MCP_PATH ? mcp.fetch(request) : sdk.hono.fetch(request);
      },
    });
    const origin = listener.serverUrl;
    return {
      sdk, ledger, origin, productId,
      mcpUrl: `${origin}${MCP_PATH}`,
      async pairingCode(): Promise<string> { return (await sdk.pairing.createPairingCode({ productId })).code; },
      /** Resolves with the first registered device. */
      async firstDevice(signal?: AbortSignal, pollMs = 500): Promise<string> {
        for (;;) {
          const [device] = await sdk.machines.list();
          if (device) return device.deviceId;
          signal?.throwIfAborted();
          await new Promise(resolve => setTimeout(resolve, pollMs));
        }
      },
      issueGrokBotKey(deviceId: string, runtimes: readonly RuntimeId[] = ['pi']): { token: string; key: KeyInfo } {
        return ledger.issueKey({ label: 'Grok Bot', scopes: GROK_BOT_SCOPES, deviceIds: [deviceId], runtimes });
      },
      async close(): Promise<void> {
        endpoint?.close();
        await listener.close();
        await sdk.close();
        ledger.close();
      },
    };
  } catch (error) {
    endpoint?.close(); await sdk.close(); ledger.close();
    throw error;
  }
}

function args(argv: string[]) {
  const value = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const runtimes = argv.flatMap((a, i) => a === '--runtime' ? [argv[i + 1] as RuntimeId] : []);
  return { stateDir: path.resolve(value('--state') ?? '.byok-mcp-host'), issueKey: argv.includes('--issue-key'),
    revoke: value('--revoke'), runtimes: runtimes.length ? runtimes : ['pi' as RuntimeId] };
}

async function main(argv: string[]): Promise<void> {
  const opts = args(argv);
  const productId = process.env.BYOK_MCP_HOST_PRODUCT_ID;
  if (opts.revoke) {
    const ledger = new BetaLedger(path.join(opts.stateDir, 'beta.sqlite'), productId ?? 'byok-mcp-host');
    try { console.log(ledger.revokeKey(opts.revoke) ? `revoked ${opts.revoke}` : `no active key ${opts.revoke}`); } finally { ledger.close(); }
    return;
  }
  const host = await startHost({ stateDir: opts.stateDir, ...(productId ? { productId } : {}) });
  const stop = new AbortController();
  const shutdown = () => { stop.abort(); void host.close().then(() => process.exit(0)); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);

  console.log(`byok MCP Host on ${host.origin} (product ${host.productId}, state ${opts.stateDir})`);
  console.log(`MCP endpoint: ${host.mcpUrl}`);
  if ((await host.sdk.machines.list()).length === 0) {
    console.log('\nPair a device (daemon config productId and serverUrl must match):');
    console.log(`  byok-agent pair ${await host.pairingCode()} --server ${host.origin} --config <daemon-config.json>`);
    console.log('  byok-agent start --config <daemon-config.json>');
  }
  if (!opts.issueKey) return;

  const deviceId = await host.firstDevice(stop.signal);
  const { token, key } = host.issueGrokBotKey(deviceId, opts.runtimes);
  console.log(`\nGrok Bot key ${key.keyId}: scopes ${key.scopes.join(', ')}; device ${deviceId}; runtimes ${key.runtimes.join(', ')}`);
  console.log('Paste this as the Grok Bot custom MCP server entry. The token is shown only now:');
  console.log(JSON.stringify(grokBotEntry(host.mcpUrl, token), null, 2));
  console.log(`\nRevoke: stop this Host, then  bun run host -- --state ${opts.stateDir} --revoke ${key.keyId}`);
  console.log('Reachability: Grok Bot calls custom MCP servers from the Cursor backend or its cloud computer.');
  console.log('A loopback URL reaches this Host only if the live check G1 (placement "client") passes;');
  console.log('otherwise put this origin behind public HTTPS or a tunnel and use that URL in the entry.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
