import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DaemonConfig } from '../../daemon/create-daemon';
import { decodeTeamMemberContext } from '../../daemon/team-workspace';
import { resolveSdkReservedHelperBin } from '../../sdk-reserved-helper-host';
import { connectControlClient } from '../control-client';
import { resolveStoreDir } from '../config';
import { loadPrivateTeamDocument, parseCodexTeamBinding, preflightCodexRelay, queueCodexTeamNotification, type CodexTeamBinding } from '../team-codex-relay';
import { TeamNotificationRelay, type TeamRelayBinding } from '../team-notification-relay';
import { PiTeamSession, type PiInteractionResponse } from '../team-pi-session';
import { acquireTeamRelayLock } from './team-relay';

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function parsePiRelayBindings(value: unknown, workspaceId: string) {
  if (!record(value) || !exact(value, ['version', 'codex', 'pi']) || value.version !== 1) throw new Error('Pi relay requires version 1, codex and pi bindings');
  const codex = parseCodexTeamBinding(value.codex, workspaceId); const pi = value.pi;
  if (!record(pi) || !exact(pi, ['context', 'afterSeq', 'cwd', 'sessionDir', 'provider', 'model', 'systemPrompt', 'extensionPaths']) ||
    typeof pi.context !== 'string' || !Number.isSafeInteger(pi.afterSeq) || (pi.afterSeq as number) < 0 ||
    !['cwd', 'sessionDir', 'provider', 'model', 'systemPrompt'].every(k => typeof pi[k] === 'string' && pi[k].length > 0) ||
    !Array.isArray(pi.extensionPaths) || pi.extensionPaths.length > 8 || !pi.extensionPaths.every(p => typeof p === 'string' && path.isAbsolute(p)) ||
    !path.isAbsolute(pi.cwd as string) || !path.isAbsolute(pi.sessionDir as string)) throw new Error('invalid Pi relay binding');
  const lease = decodeTeamMemberContext(pi.context);
  if (lease.workspaceId !== workspaceId || lease.memberId === codex.lease.memberId) throw new Error('Pi relay requires distinct members in one workspace');
  return { codex, pi: { context: pi.context, lease, afterSeq: pi.afterSeq as number, cwd: pi.cwd as string, sessionDir: pi.sessionDir as string,
    provider: pi.provider as string, model: pi.model as string, systemPrompt: pi.systemPrompt as string, extensionPaths: pi.extensionPaths as string[] } };
}
type Binding = (CodexTeamBinding & { kind: 'codex' }) | (TeamRelayBinding & { kind: 'pi' });
export async function runTeamPiRelayCommand(input: {
  config: DaemonConfig; workspaceId: string; bindingsFile: string; codexBin: string; maxNotifications: number; signal: AbortSignal;
}): Promise<void> {
  if (!Number.isInteger(input.maxNotifications) || input.maxNotifications < 1 || input.maxNotifications > 100) throw new Error('max-notifications must be from 1 to 100');
  const document = parsePiRelayBindings(await loadPrivateTeamDocument(input.bindingsFile), input.workspaceId);
  if (!path.isAbsolute(input.codexBin)) throw new Error('Codex executable must be absolute');
  const codexBin = await fs.realpath(input.codexBin);
  await preflightCodexRelay(codexBin, input.signal);
  const storeDir = resolveStoreDir(input.config);
  const connection = await connectControlClient({ storeDir, productId: input.config.productId });
  if (!connection.ok) throw new Error(connection.reason);
  const client = connection.client;
  let release: (() => Promise<void>) | undefined;
  let pi: PiTeamSession | undefined;
  let commands: ReturnType<typeof createInterface> | undefined;
  let relay: TeamNotificationRelay<Binding> | undefined;
  const abort = new AbortController();
  const stop = () => { abort.abort(); relay?.stop(); };
  const emit = (event: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(event)}\n`); };
  input.signal.addEventListener('abort', stop, { once: true });
  try {
    release = await acquireTeamRelayLock(storeDir, input.workspaceId);
    if (input.signal.aborted) throw new Error('relay stopped');
    for (const binding of [document.codex, document.pi]) await client.request('team_notifications.snapshot', { context: binding.context, afterSeq: binding.afterSeq });
    // The installed manifest is the authority for packaged helper entrypoints.
    const manifestPath = fileURLToPath(import.meta.resolve('@byok-sdk/client/package.json'));
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { bin: Record<string, string> };
    const helper = input.config.sdkHelperHost ? resolveSdkReservedHelperBin('agent-team-mcp', input.config.sdkHelperHost)
      : { command: process.execPath, args: [path.resolve(path.dirname(manifestPath), manifest.bin['byok-agent-team-mcp']!)] };
    pi = await PiTeamSession.start({ ...document.pi, workspaceId: input.workspaceId, onEvent: emit,
      mcpConfig: { settings: { hostConfigDiscovery: 'off', scriptMode: false, disableProxyTool: true }, mcpServers: { byokagentteam: {
        command: helper.command, args: helper.args, env: { BYOK_STORE_DIR: storeDir, BYOK_PRODUCT_ID: input.config.productId, BYOK_TEAM_MEMBER_CONTEXT: document.pi.context },
        lifecycle: 'eager', directTools: true, toolPrefix: 'none', includeTools: ['post_team_message', 'read_team_messages', 'ack_team_messages'], exposeResources: false,
      } } },
    });
    const host = pi;
    relay = new TeamNotificationRelay<Binding>({ bindings: [{ ...document.codex, kind: 'codex' }, { ...document.pi, kind: 'pi' }], maxNotifications: input.maxNotifications,
      describe: b => ({ harness: b.kind, sessionId: b.kind === 'codex' ? b.threadId : host.status().sessionId! }),
      snapshot: (b, afterSeq) => client.request('team_notifications.snapshot', { context: b.context, afterSeq }),
      ready: b => b.kind === 'pi' ? host.ready() : Promise.resolve(true),
      enqueue: async (b, throughSeq, signal) => {
        const event = { harness: b.kind, memberId: b.lease.memberId, throughSeq, attempt: relay!.status().attempts };
        emit({ event: 'queue_attempt', ...event });
        const queueId = b.kind === 'pi' ? await host.notify(throughSeq, signal) : await queueCodexTeamNotification({ codexBin, binding: b, throughSeq, signal });
        emit({ event: 'queue_accepted', ...event, queueId }); return queueId;
      },
    });
    const status = () => emit({ event: 'status', ...relay!.status(), pi: host.status() });
    commands = createInterface({ input: process.stdin, terminal: false });
    let operations = 0;
    commands.on('line', line => {
      // Do not serialize a prompt behind its own GUI response.
      if (Buffer.byteLength(line) > 32_768 || operations >= 32) { emit({ event: 'command_rejected', reason: 'command_limit' }); return; }
      operations++;
      void (async () => {
        const v: unknown = JSON.parse(line);
        if (!record(v) || typeof v.command !== 'string') throw new Error('invalid command');
        if (exact(v, ['command']) && ['pause', 'resume', 'status', 'stop'].includes(v.command)) {
          if (v.command === 'pause') relay!.pause(); else if (v.command === 'resume') relay!.resume(); else if (v.command === 'stop') stop();
          status();
        } else if (v.command === 'respond' && exact(v, ['command', 'sessionId', 'requestId', 'response']) && typeof v.sessionId === 'string' && typeof v.requestId === 'string') {
          await host.respond(v as unknown as PiInteractionResponse);
        } else if (v.command === 'input' && exact(v, ['command', 'sessionId', 'message']) && v.sessionId === host.status().sessionId && typeof v.message === 'string') {
          if (!['running', 'paused'].includes(relay!.status().state)) throw new Error('relay admission ended');
          const queueId = await host.sendInput(v.message); emit({ event: 'input_accepted', sessionId: v.sessionId, queueId });
        } else throw new Error('invalid command');
      })().catch(() => emit({ event: 'command_rejected', reason: 'invalid_or_unavailable' })).finally(() => { operations--; });
    });
    commands.on('close', stop);
    status();
    while (['running', 'paused'].includes(relay.status().state) && !abort.signal.aborted) {
      const before = JSON.stringify(relay.status()); await relay.tick();
      if (before !== JSON.stringify(relay.status())) status();
      if (relay.status().state === 'failed') throw new Error(`team Pi relay failed: ${relay.status().error}`);
      if (host.status().phase === 'failed') throw new Error('Pi session failed');
      if (['running', 'paused'].includes(relay.status().state)) await new Promise(resolve => setTimeout(resolve, 250));
    }
    // Budget stops new admission, not already accepted Pi work. GUI remains live.
    if (relay.status().state === 'budget_exhausted') await host.drain(abort.signal);
  } finally {
    stop(); commands?.close(); input.signal.removeEventListener('abort', stop);
    try { await pi?.stop(); } finally { client.close(); await release?.(); }
  }
}
