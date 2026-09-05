import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiInteractionGate } from '../adapters/pi/team-interaction-extension';
import { PiRpcClient, type PiRpcMessage } from '../adapters/pi/rpc-client';
import { resolvePiBin } from '../adapters/pi/resolve-bin';
import { PiTeamSession } from '../bin/team-pi-session';

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
  it('the exact native RPC holds input until exact-ID GUI response, with no model call', async () => {
    const { dir, extension } = await fixture(); const frames: PiRpcMessage[] = []; const requests: PiRpcMessage[] = [];
    const client = new PiRpcClient({ command: resolvePiBin().command, cwd: dir,
      args: ['--mode','rpc','--no-session','--no-extensions','--no-context-files','--no-skills','--no-prompt-templates','--no-themes',
        '--extension',path.resolve('dist/adapters/pi/team-interaction-extension.js'),'--extension',extension],
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
    const host = await PiTeamSession.start({workspaceId:'room',cwd:dir,sessionDir:path.join(dir,'session'),provider:'zai',model:'glm-5.3',systemPrompt:'Synthetic no-model probe.',extensionPaths:[extension],
      mcpConfig:{settings:{hostConfigDiscovery:'off',scriptMode:false,disableProxyTool:true},mcpServers:{}},onEvent:e=>events.push(e)}); children.push(host);
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
