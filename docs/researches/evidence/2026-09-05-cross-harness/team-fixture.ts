/** Probe composition only: actual SDK store/control/helper, disposable local state. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalTeamWorkspace, encodeTeamMemberContext, decodeTeamMemberContext } from '../../../../packages/client/src/daemon/team-workspace';
import { startControlServer } from '../../../../packages/client/src/daemon/control-server';
import { connectControlClient } from '../../../../packages/client/src/bin/control-client';
import { runSdkReservedHelper } from '../../../../packages/client/src/bin/sdk-reserved-helper-runners';
import { parseTeamMessagePostParams, parseTeamMessageReadParams, parseTeamMessageAckParams, ControlError } from '../../../../packages/client/src/daemon/control-protocol';

const [mode, scratch, member = 'operator', ...rest] = process.argv.slice(2);
if (!scratch?.startsWith('/tmp/byok-harness-probe-')) throw new Error('requires a disposable probe root');
const storeDir = path.join(scratch, 'store');
const productId = 'cross-harness-probe';
const self = fileURLToPath(import.meta.url);
const logPath = path.join(scratch, 'control-events.jsonl');
const record = (value: unknown) => fs.appendFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...value as object })}\n`, { mode: 0o600 });

if (mode === 'helper') {
  const context = await fs.readFile(path.join(scratch, member, 'member.context'), 'utf8');
  process.env.BYOK_STORE_DIR = storeDir;
  process.env.BYOK_PRODUCT_ID = productId;
  process.env.BYOK_TEAM_MEMBER_CONTEXT = context;
  await runSdkReservedHelper('agent-team-mcp');
} else if (mode === 'start') {
  const workspace = new LocalTeamWorkspace(storeDir);
  await workspace.createWorkspace({ workspaceId: 'probe-room', members: ['operator', 'claude', 'codex', 'pi'], limits: { maxMembers: 4, maxMessages: 64, maxBytes: 65536 } });
  for (const name of ['operator', 'claude', 'codex', 'pi']) {
    const dir = path.join(scratch, name);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const lease = await workspace.createMemberLease({ workspaceId: 'probe-room', memberId: name, ttlMs: 3600000 });
    await fs.writeFile(path.join(dir, 'member.context'), encodeTeamMemberContext(lease), { mode: 0o600 });
    await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { byokagentteam: { command: process.execPath, args: [self, 'helper', scratch, name] } } }), { mode: 0o600 });
  }
  const handle = await startControlServer({ storeDir, productId, methods: { stream: {}, unary: {
    'team_messages.post': async params => {
      const p = parseTeamMessagePostParams(params);
      if (!p) throw new ControlError('bad_request', 'invalid post');
      const lease = decodeTeamMemberContext(p.context);
      const result = await workspace.postMessage({ lease, body: p.body, ...(p.contentType ? { contentType: p.contentType } : {}) });
      await record({ method: 'post', member: lease.memberId, seq: result.seq, messageId: result.messageId });
      return result;
    },
    'team_messages.read': async params => {
      const p = parseTeamMessageReadParams(params);
      if (!p) throw new ControlError('bad_request', 'invalid read');
      const lease = decodeTeamMemberContext(p.context);
      const result = await workspace.readMessages({ lease, ...(p.afterSeq === undefined ? {} : { afterSeq: p.afterSeq }) });
      await record({ method: 'read', member: lease.memberId, deliveredThroughSeq: result.deliveredThroughSeq, count: result.messages.length });
      return result;
    },
    'team_messages.ack': async params => {
      const p = parseTeamMessageAckParams(params);
      if (!p) throw new ControlError('bad_request', 'invalid ack');
      const lease = decodeTeamMemberContext(p.context);
      const result = await workspace.ackMessages({ lease, throughSeq: p.throughSeq });
      await record({ method: 'ack', member: lease.memberId, throughSeq: result.throughSeq });
      return result;
    },
    'team_messages.inspect': () => workspace.inspectMessages('probe-room'),
  } } });
  process.stdout.write(`${JSON.stringify({ ready: true, scratch, composition: 'actual-sdk-store-control-helper' })}\n`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await handle.close(); process.exit(0); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} else if (mode === 'seed' || mode === 'inspect') {
  const result = await connectControlClient({ storeDir, productId });
  if (!result.ok) throw new Error(result.reason);
  try {
    const context = await fs.readFile(path.join(scratch, member, 'member.context'), 'utf8');
    const value = mode === 'seed'
      ? await result.client.request('team_messages.post', { context, body: rest.join(' ') })
      : await result.client.request('team_messages.inspect');
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } finally { result.client.close(); }
} else throw new Error('unknown probe mode');
