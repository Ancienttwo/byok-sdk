/**
 * Disposable composition fixture for the agent-gateway probe.
 *
 * It owns only the SDK TeamWorkspace/control/helper surfaces. Native Pi and
 * Codex session delivery stay in their respective probe harnesses.
 */
import { appendFile, readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalTeamWorkspace,
  decodeTeamMemberContext,
  encodeTeamMemberContext,
} from '../../../packages/client/src/daemon/team-workspace';
import { startControlServer } from '../../../packages/client/src/daemon/control-server';
import { connectControlClient } from '../../../packages/client/src/bin/control-client';
import { runSdkReservedHelper } from '../../../packages/client/src/bin/sdk-reserved-helper-runners';
import {
  ControlError,
  parseTeamMessageAckParams,
  parseTeamMessageInspectParams,
  parseTeamMessagePostParams,
  parseTeamMessageReadParams,
  parseTeamNotificationSnapshotParams,
} from '../../../packages/client/src/daemon/control-protocol';

const WORKSPACE_ID = 'gateway-probe';
const MEMBERS = ['alice', 'bob'] as const;
const PRODUCT_ID = 'agent-gateway-probe';
const LIMITS = Object.freeze({ maxMembers: 2, maxMessages: 16, maxBytes: 16_384 });
const LEASE_TTL_MS = 60 * 60 * 1000;
const SELF = fileURLToPath(import.meta.url);

type Member = typeof MEMBERS[number];

function requireMember(value: string | undefined): Member {
  if (value === 'alice' || value === 'bob') return value;
  throw new Error('member must be alice or bob');
}

function requireSeq(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) throw new Error('throughSeq must be a non-negative integer');
  const seq = Number(value);
  if (!Number.isSafeInteger(seq)) throw new Error('throughSeq must be a non-negative integer');
  return seq;
}

function isProbeScratch(value: string): boolean {
  return value.startsWith('/tmp/byok-gateway-probe-') || value.startsWith('/private/tmp/byok-gateway-probe-');
}

async function resolveScratch(value: string | undefined): Promise<string> {
  if (!value) throw new Error('scratch path is required');
  const resolved = await realpath(value);
  if (!isProbeScratch(resolved)) throw new Error('requires a disposable /tmp/byok-gateway-probe-* root');
  return resolved;
}

function paths(scratch: string): { readonly storeDir: string; readonly logPath: string } {
  return { storeDir: path.join(scratch, 'store'), logPath: path.join(scratch, 'control-events.jsonl') };
}

async function memberContext(scratch: string, member: Member): Promise<string> {
  return readFile(path.join(scratch, member, 'member.context'), 'utf8');
}

async function record(logPath: string, value: Record<string, unknown>): Promise<void> {
  await appendFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...value })}\n`, { mode: 0o600 });
}

async function inspectWorkspace(workspace: LocalTeamWorkspace, storeDir: string, afterSeq = 0): Promise<unknown> {
  const status = await workspace.getWorkspace(WORKSPACE_ID);
  if (status === undefined) throw new Error(`workspace ${WORKSPACE_ID} is missing`);
  const messages = await workspace.inspectMessages(WORKSPACE_ID, afterSeq);
  const statePath = path.join(storeDir, 'team-workspaces', 'v1', 'state.json');
  const stored = JSON.parse(await readFile(statePath, 'utf8')) as { workspaces?: Record<string, { receipts?: unknown }> };
  const receipts = stored.workspaces?.[WORKSPACE_ID]?.receipts;
  if (receipts === undefined) throw new Error(`workspace ${WORKSPACE_ID} receipts are missing`);
  return { messages, receipts, status };
}

async function writeMemberFiles(scratch: string, workspace: LocalTeamWorkspace): Promise<void> {
  for (const member of MEMBERS) {
    const dir = path.join(scratch, member);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lease = await workspace.createMemberLease({ workspaceId: WORKSPACE_ID, memberId: member, ttlMs: LEASE_TTL_MS });
    const context = encodeTeamMemberContext(lease);
    await writeFile(path.join(dir, 'member.context'), context, { mode: 0o600 });
    await writeFile(path.join(dir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        byokagentteam: { command: process.execPath, args: [SELF, 'helper', scratch, member] },
      },
    }), { mode: 0o600 });
  }
}

async function validateOriginalMemberContexts(scratch: string, workspace: LocalTeamWorkspace): Promise<void> {
  for (const member of MEMBERS) {
    const context = await memberContext(scratch, member);
    const lease = decodeTeamMemberContext(context);
    if (lease.workspaceId !== WORKSPACE_ID || lease.memberId !== member) throw new Error(`member context for ${member} is not bound to ${WORKSPACE_ID}`);
    await workspace.validateMemberLease(lease);
  }
}

async function serve(mode: 'start' | 'restart', scratch: string): Promise<void> {
  const { storeDir, logPath } = paths(scratch);
  const workspace = new LocalTeamWorkspace(storeDir);
  if (mode === 'start') {
    await workspace.createWorkspace({ workspaceId: WORKSPACE_ID, members: [...MEMBERS], limits: LIMITS });
    await writeMemberFiles(scratch, workspace);
  } else {
    if (await workspace.getWorkspace(WORKSPACE_ID) === undefined) throw new Error('restart requires an existing gateway-probe workspace');
    await validateOriginalMemberContexts(scratch, workspace);
  }

  const handle = await startControlServer({
    storeDir,
    productId: PRODUCT_ID,
    methods: {
      stream: {},
      unary: {
        'team_notifications.snapshot': async (params) => {
          const input = parseTeamNotificationSnapshotParams(params);
          if (!input) throw new ControlError('bad_request', 'invalid notification snapshot');
          const lease = decodeTeamMemberContext(input.context);
          return workspace.notificationSnapshot({ lease, ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }) });
        },
        'team_messages.post': async (params) => {
          const input = parseTeamMessagePostParams(params);
          if (!input) throw new ControlError('bad_request', 'invalid team message post');
          const lease = decodeTeamMemberContext(input.context);
          const result = await workspace.postMessage({ lease, body: input.body, ...(input.contentType === undefined ? {} : { contentType: input.contentType }) });
          await record(logPath, { method: 'post', member: lease.memberId, body: input.body, seq: result.seq, messageId: result.messageId });
          return result;
        },
        'team_messages.read': async (params) => {
          const input = parseTeamMessageReadParams(params);
          if (!input) throw new ControlError('bad_request', 'invalid team message read');
          const lease = decodeTeamMemberContext(input.context);
          const result = await workspace.readMessages({ lease, ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }) });
          await record(logPath, {
            method: 'read',
            member: lease.memberId,
            afterSeq: result.afterSeq,
            deliveredThroughSeq: result.deliveredThroughSeq,
            messages: result.messages.map((message) => ({ seq: message.seq, messageId: message.messageId, senderMemberId: message.senderMemberId, body: message.body })),
          });
          return result;
        },
        'team_messages.ack': async (params) => {
          const input = parseTeamMessageAckParams(params);
          if (!input) throw new ControlError('bad_request', 'invalid team message acknowledgement');
          const lease = decodeTeamMemberContext(input.context);
          const result = await workspace.ackMessages({ lease, throughSeq: input.throughSeq });
          await record(logPath, { method: 'ack', member: lease.memberId, throughSeq: result.throughSeq });
          return result;
        },
        'team_messages.inspect': async (params) => {
          const input = parseTeamMessageInspectParams(params);
          if (!input || input.workspaceId !== WORKSPACE_ID) throw new ControlError('bad_request', 'invalid team message inspection');
          return inspectWorkspace(workspace, storeDir, input.afterSeq ?? 0);
        },
      },
    },
  });

  process.stdout.write(`${JSON.stringify({ ready: true, mode, scratch, workspaceId: WORKSPACE_ID, members: MEMBERS, composition: 'actual-sdk-teamworkspace-control-helper' })}\n`);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => { void close(); });
  process.on('SIGINT', () => { void close(); });
}

async function withClient<T>(scratch: string, action: (request: <TResult = unknown>(method: string, params?: unknown) => Promise<TResult>) => Promise<T>): Promise<T> {
  const { storeDir } = paths(scratch);
  const connected = await connectControlClient({ storeDir, productId: PRODUCT_ID });
  if (!connected.ok) throw new Error(connected.reason);
  try {
    return await action((method, params) => connected.client.request(method, params));
  } finally {
    connected.client.close();
  }
}

async function main(): Promise<void> {
  const [mode, scratchArg, memberArg, ...rest] = process.argv.slice(2);
  const scratch = await resolveScratch(scratchArg);
  if (mode === 'helper') {
    const member = requireMember(memberArg);
    process.env.BYOK_STORE_DIR = paths(scratch).storeDir;
    process.env.BYOK_PRODUCT_ID = PRODUCT_ID;
    process.env.BYOK_TEAM_MEMBER_CONTEXT = await memberContext(scratch, member);
    await runSdkReservedHelper('agent-team-mcp');
    return;
  }
  if (mode === 'start' || mode === 'restart') return serve(mode, scratch);
  if (mode === 'seed') {
    const member = requireMember(memberArg);
    const body = rest.join(' ');
    if (!body) throw new Error('seed body is required');
    const context = await memberContext(scratch, member);
    const result = await withClient(scratch, (request) => request('team_messages.post', { context, body }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (mode === 'read') {
    const member = requireMember(memberArg);
    const context = await memberContext(scratch, member);
    const afterSeq = rest[0] === undefined ? undefined : requireSeq(rest[0]);
    const result = await withClient(scratch, (request) => request('team_messages.read', { context, ...(afterSeq === undefined ? {} : { afterSeq }) }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (mode === 'ack') {
    const member = requireMember(memberArg);
    const context = await memberContext(scratch, member);
    const throughSeq = requireSeq(rest[0]);
    const result = await withClient(scratch, (request) => request('team_messages.ack', { context, throughSeq }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (mode === 'inspect') {
    const afterSeq = memberArg === undefined ? undefined : requireSeq(memberArg);
    const result = await withClient(scratch, (request) => request('team_messages.inspect', { workspaceId: WORKSPACE_ID, ...(afterSeq === undefined ? {} : { afterSeq }) }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error('unknown fixture mode');
}

await main();
