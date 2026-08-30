import path from 'node:path';
import type { DaemonConfig } from '../../daemon/create-daemon';
import { AGENT_TEAM_MCP_SERVER_NAME } from '../../sdk-reserved-mcp';
import { resolveSdkReservedHelperBin } from '../../sdk-reserved-helper-host';
import { connectControlClient, type ControlClient } from '../control-client';
import { openTeamTmuxView } from '../team-tmux-view';
import { resolveStoreDir } from '../config';

async function connect(config: DaemonConfig): Promise<ControlClient> {
  const result = await connectControlClient({ storeDir: resolveStoreDir(config), productId: config.productId });
  if (!result.ok) throw new Error(result.reason);
  return result.client;
}

export async function runTeamCreateCommand(config: DaemonConfig, workspaceId: string, members: readonly string[]): Promise<void> {
  const client = await connect(config);
  try {
    const result = await client.request('team_workspaces.create', { workspaceId, members: [...members], limits: { maxMembers: 16, maxMessages: 10_000, maxBytes: 16 * 1024 * 1024 } });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { client.close(); }
}

export async function runTeamListCommand(config: DaemonConfig): Promise<void> {
  const client = await connect(config);
  try { process.stdout.write(`${JSON.stringify(await client.request('team_workspaces.list'))}\n`); } finally { client.close(); }
}

export async function runTeamJoinCommand(config: DaemonConfig, workspaceId: string, memberId: string): Promise<void> {
  const client = await connect(config);
  try {
    const joined = await client.request<{ context: string; workspaceId: string; memberId: string; expiresAt: string }>('team_workspaces.join', { workspaceId, memberId });
    const helper = resolveSdkReservedHelperBin('agent-team-mcp', config.sdkHelperHost);
    process.stdout.write(`${JSON.stringify({
      workspaceId: joined.workspaceId,
      memberId: joined.memberId,
      expiresAt: joined.expiresAt,
      mcpServers: { [AGENT_TEAM_MCP_SERVER_NAME]: { command: helper.command, args: helper.args, env: { BYOK_STORE_DIR: resolveStoreDir(config), BYOK_PRODUCT_ID: config.productId, BYOK_TEAM_MEMBER_CONTEXT: joined.context } } },
    })}\n`);
  } finally { client.close(); }
}

export async function runTeamPostCommand(config: DaemonConfig, context: string, body: string): Promise<void> {
  const client = await connect(config);
  try { process.stdout.write(`${JSON.stringify(await client.request('team_messages.post', { context, body }))}\n`); } finally { client.close(); }
}

export async function runTeamReadCommand(config: DaemonConfig, context: string, afterSeq?: number): Promise<void> {
  const client = await connect(config);
  try { process.stdout.write(`${JSON.stringify(await client.request('team_messages.read', { context, ...(afterSeq === undefined ? {} : { afterSeq }) }))}\n`); } finally { client.close(); }
}

export async function runTeamAckCommand(config: DaemonConfig, context: string, throughSeq: number): Promise<void> {
  const client = await connect(config);
  try { process.stdout.write(`${JSON.stringify(await client.request('team_messages.ack', { context, throughSeq }))}\n`); } finally { client.close(); }
}

export async function runTeamWatchCommand(config: DaemonConfig, workspaceId: string, signal: AbortSignal): Promise<void> {
  const client = await connect(config);
  let afterSeq = 0;
  try {
    while (!signal.aborted) {
      const messages = await client.request<Array<{ seq: number }>>('team_messages.inspect', { workspaceId, afterSeq });
      for (const message of messages) { process.stdout.write(`${JSON.stringify(message)}\n`); afterSeq = Math.max(afterSeq, message.seq); }
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 500); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  } finally { client.close(); }
}

export async function runTeamOpenCommand(input: { config: DaemonConfig; configPath: string; workspaceId: string; tmuxBin: string; sessionName?: string }): Promise<void> {
  const entry = process.argv[1];
  if (!entry || !path.isAbsolute(entry)) throw new Error('team open requires an absolute byok-agent entrypoint');
  const result = await openTeamTmuxView({
    tmuxBin: input.tmuxBin,
    sessionName: input.sessionName ?? `byok-${input.workspaceId}`,
    watcherCommand: process.execPath,
    watcherArgs: [entry, 'team', 'watch', input.workspaceId, '--config', path.resolve(input.configPath)],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
