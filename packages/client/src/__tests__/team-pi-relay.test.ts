import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiInteractionGate } from '../adapters/pi/team-interaction-extension';
import { PiRpcClient, type PiRpcMessage } from '../adapters/pi/rpc-client';
import { resolvePiBin } from '../adapters/pi/resolve-bin';
import { PiTeamSession } from '../bin/team-pi-session';
import { serializePiHostConfig } from '../adapters/pi/runtime-host-binding';
import { PI_TEAM_OPERATOR_TOKEN } from '../bin/team-pi-operator-entry';
import { runSdkReservedHelperCommand } from '../sdk-reserved-helper-host';
import { RUNTIME_LAUNCH_KINDS } from '../daemon/tool-implementation-identity';
import { runTeamPiRelayCommand } from '../bin/commands/team-pi-relay';

const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const dirs: string[] = []; const children: Array<{ dispose?: () => Promise<void>; stop?: () => Promise<void> }> = [];
afterEach(async () => { for (const c of children.splice(0)) await (c.dispose?.() ?? c.stop?.()); for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function until(predicate: () => boolean) {
  const end = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > end) throw new Error('native event deadline'); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-gate-')); dirs.push(dir);
  const extension = path.join(dir, 'probe.mjs');
  await fs.writeFile(extension, `export default function(pi) {
    pi.registerCommand('probe-dialog', { handler: async (_args, ctx) => { void ctx.ui.confirm('synthetic', 'operator response'); } });
    pi.registerCommand('probe-timeout', { handler: async (_args, ctx) => { void ctx.ui.confirm('synthetic timeout', 'operator response', {timeout:100}); } });
    pi.on('input', (_e, ctx) => { ctx.ui.setStatus('probe_input_admitted', 'true'); return {action:'handled'}; });
  }`);
  return { dir, extension };
}

describe('Pi native interaction admission', () => {
  it('does not admit the operator entry through daemon runtime or reserved helper dispatch', async () => {
    expect(RUNTIME_LAUNCH_KINDS).toEqual(['pi-rpc', 'pi-prepared']);
    expect(await runSdkReservedHelperCommand([PI_TEAM_OPERATOR_TOKEN])).toBe(false);
    await expect(runSdkReservedHelperCommand(['__byok_sdk_helper', PI_TEAM_OPERATOR_TOKEN])).rejects.toThrow('invalid SDK-reserved helper command');
  });
  it('refuses a product helper host before reading relay data or spawning', async () => {
    await expect(runTeamPiRelayCommand({ config: { sdkHelperHost: { mode: 'self-executable' } } } as never))
      .rejects.toThrow('unsupported by product sdkHelperHost');
  });
  it('holds unknown state and rechecks the next dialog after wakeup', async () => {
    const events: unknown[] = []; const gate = new PiInteractionGate(e => events.push(e)); let admitted = false;
    gate.start('session'); gate.openPrompt(); const waiting = gate.wait().then(() => { admitted = true; });
    await microtasks(); expect(admitted).toBe(false);
    gate.closePrompt(); queueMicrotask(() => gate.openPrompt());
    await microtasks(); expect(admitted).toBe(false);
    gate.closePrompt(); await waiting; expect(admitted).toBe(true);
    gate.fail(); admitted = false; void gate.wait().then(() => { admitted = true; });
    await microtasks(); expect(admitted).toBe(false); expect(events).toHaveLength(6);
  });
  it('lets a cancelled run leave a normal hold but never opens a fatal gate', async () => {
    const gate = new PiInteractionGate(() => {}); gate.start('s'); gate.openPrompt(); const abort = new AbortController();
    const held = gate.wait(abort.signal); await microtasks(); abort.abort(); await held;
    gate.fail(); let admitted = false; void gate.wait(abort.signal).then(() => { admitted = true; }); await microtasks(); expect(admitted).toBe(false);
  });
  it.each(['native-control', 'operator'] as const)('%s RPC holds input until exact-ID GUI response, with no model call', async lane => {
    const { dir, extension } = await fixture(); const frames: PiRpcMessage[] = []; const requests: PiRpcMessage[] = [];
    let invocation = { command: resolvePiBin().command, args: ['--mode','rpc','--no-session','--no-extensions','--no-context-files','--no-skills','--no-prompt-templates','--no-themes',
        '--extension',path.resolve('dist/adapters/pi/team-interaction-extension.js'),'--extension',extension] };
    if (lane === 'operator') {
      const prompt = path.join(dir, 'prompt.txt'); await fs.writeFile(prompt, 'Synthetic operator prompt.');
      const configPath = path.join(dir, 'operator.json');
      const serialized = serializePiHostConfig({format:'byok.pi.team-operator',version:1,cwd:dir,sessionDir:path.join(dir,'sessions'),
        provider:'zai',model:'glm-5.3',systemPromptPath:prompt,extensionPaths:[extension],
        mcp:{mcpEnv:{},mcpServers:{},observation:{},permissionMode:'auto'}});
      await fs.writeFile(configPath, serialized.bytes);
      invocation = {command:process.execPath,args:[path.resolve('dist/bin/byok-agent.js'),PI_TEAM_OPERATOR_TOKEN,
        `--config-digest=${serialized.digest}`,'--config',configPath]};
    }
    const client = new PiRpcClient({ ...invocation, cwd: dir,
      env: process.env, onFrame: e => frames.push(e), extensionUi: { mode: 'hold', onRequest: e => requests.push(e) },
    }); children.push(client);
    void (async () => { for await (const _event of client.events) {} })();
    expect((await client.send({type:'get_state'})).success).toBe(true);
    expect((await client.send({type:'prompt',message:'/probe-dialog'})).success).toBe(true);
    await until(() => requests.filter(e => e.method === 'confirm').length === 1 && frames.some(e => e.statusKey === 'byok_team_gate' && JSON.parse(String(e.statusText)).phase === 'waiting'));
    let accepted = false; const pending = client.send({type:'prompt',message:'synthetic input', streamingBehavior:'followUp'}).then(r => { accepted = true; return r; });
    await new Promise(r => setTimeout(r, 100)); expect(accepted).toBe(false); expect(frames.some(e => e.statusKey === 'probe_input_admitted')).toBe(false);
    await client.respondExtensionUi({id:requests.find(e => e.method === 'confirm')!.id!,cancelled:true});
    expect((await pending).success).toBe(true); expect(frames.some(e => e.statusKey === 'probe_input_admitted')).toBe(true);
    expect(frames.some(e => e.type === 'agent_start')).toBe(false);
  }, 20_000);
  it('owned GUI host keeps expired request IDs until explicit response and rejects stale replies', async () => {
    const { dir, extension } = await fixture(); const events: Record<string,unknown>[] = [];
    const host = await PiTeamSession.start({operatorInvocation:{command:process.execPath,args:[path.resolve('dist/bin/byok-agent.js'),PI_TEAM_OPERATOR_TOKEN]},workspaceId:'room',cwd:dir,sessionDir:path.join(dir,'session'),provider:'zai',model:'glm-5.3',systemPrompt:'Synthetic no-model probe.',extensionPaths:[extension],
      env:{...process.env, PI_PROVIDER_API_KEY:'synthetic-relay-key', PI_CODING_AGENT_DIR:dir},
      mcpConfig:{mcpServers:{},observation:{},permissionMode:'auto'},onEvent:e=>events.push(e)}); children.push(host);
    const config = JSON.parse(await fs.readFile(path.join(dir,'session','team-mcp.json'),'utf8'));
    expect(config.mcpEnv.PI_PROVIDER_API_KEY).toBeUndefined();
    expect(config.mcpEnv.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(config.mcpEnv.BYOK_PI_MCP_CONFIG_PATH).toBeUndefined();
    expect(config.mcpEnv.PATH).toBe(process.env.PATH);
    await host.sendInput('/probe-timeout'); await until(() => host.status().phase === 'open' && host.status().pendingUi.length === 1);
    expect(await host.ready()).toBe(false);
    const requestId=host.status().pendingUi[0]!.id!; const sessionId=host.status().sessionId!;
    await expect(host.respond({sessionId:'wrong',requestId,response:{cancelled:true}})).rejects.toThrow();
    await expect(host.respond({sessionId,requestId,response:{value:'wrong shape'}})).rejects.toThrow();
    await host.respond({sessionId,requestId,response:{cancelled:true}});
    await expect(host.respond({sessionId,requestId,response:{cancelled:true}})).rejects.toThrow();
    expect(await host.ready()).toBe(true); expect(events.some(e=>e.event==='ui_response_sent')).toBe(true);
  },20_000);
});
