import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as realSpawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter, type PiAdapterOptions } from '../adapters/pi/pi-adapter';
import { parsePiAgentToolPolicy, piAgentNativeToolOptions } from '../adapters/pi/agent-tool-policy';
import { serializePiHostConfig } from '../adapters/pi/runtime-host-binding';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { sealRuntimeOperationManifest, type Session } from '../types';
import { testExecutionScratch } from './fixtures/execution-scratch';

const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session=>session.close()));
  await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));
});

describe('Pi Agent tool policy (#1061 S1)', () => {
  it.each([
    { agentBuiltinTools:['read'], agentUserContext:'excluded', agentExtensions:[] },
    { agentBuiltinTools:[], agentUserContext:'excluded', agentExtensions:['todo'] },
  ] satisfies PiAdapterOptions[])('seals the local policy only for Agent operations: %j', async (options) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'byok-pi-agent-policy-')));
    roots.push(root);
    const configs: Record<string,unknown>[] = [];
    const adapter = new PiAdapter({ ...options, resolveBin:()=>({command:FAKE_PI,source:'env'}),
      spawnFn: ((_command:string,args:string[],spawnOptions:Parameters<typeof realSpawn>[2])=>{
        const configPath = args[args.indexOf('--config')+1]!;
        // Capture the configuration while the process is being launched.
        configs.push(JSON.parse(readFileSync(configPath, 'utf8')));
        return realSpawn(FAKE_PI,args,spawnOptions);
      }) as typeof realSpawn,
    });
    for (const agent of [false,true]) {
      const session = await startPreparedOperation(adapter,{instruction:'hello'}, {
        workspaceDir:root,env:process.env,...(agent?{agentHome:root}:{}),
      });
      sessions.push(session);
    }
    expect(configs.map(config=>config.version)).toEqual([6,6]);
    expect(configs[0]?.agentToolPolicy).toEqual({builtinTools:'inherit',userContext:'inherit',extensions:'inherit'});
    expect(configs[1]?.agentToolPolicy).toEqual({builtinTools:options.agentBuiltinTools,userContext:options.agentUserContext,extensions:options.agentExtensions});
  });

  it('freezes selection at construction and binds changes into the launch digest', () => {
    const tools = ['read'];
    const policy = parsePiAgentToolPolicy({builtinTools:tools,userContext:'excluded',extensions:[]});
    tools.push('bash');
    expect(policy.builtinTools).toEqual(['read']);
    const base = {format:'byok.pi.rpc-launch',version:6,agentToolPolicy:policy};
    expect(serializePiHostConfig(base).digest).not.toBe(serializePiHostConfig({...base,agentToolPolicy:{...policy,builtinTools:['bash']}}).digest);
  });

  it.each([
    {agentBuiltinTools:['shell']}, {agentBuiltinTools:['read','read']}, {agentBuiltinTools:null},
    {agentUserContext:'excluded-ish'}, {agentExtensions:['mcp']},
  ])('rejects invalid local policy %j', options => {
    expect(()=>new PiAdapter(options as PiAdapterOptions)).toThrow('Pi Agent tool policy');
  });

  it('selects native tools without filtering MCP tools by a global allowlist', () => {
    const policy = parsePiAgentToolPolicy({builtinTools:['read','grep'],userContext:'excluded',extensions:[]});
    const options = piAgentNativeToolOptions(policy);
    expect(options.excludeTools).toEqual(['find','ls','edit','write','bash','powershell']);
    expect(options.tools).toEqual(['-find','-ls','-edit','-write','-bash','-powershell','+read','+grep']);
  });

  it('refuses a restricted Agent prepared lane before spawning or reading its prepared artifact', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'byok-pi-unsupported-policy-')));
    roots.push(root);
    let spawned = false;
    const adapter = new PiAdapter({agentBuiltinTools:[],resolveBin:()=>({command:FAKE_PI,source:'env'}),spawnFn:(()=>{spawned=true;throw new Error('unexpected spawn');}) as never});
    const prepared = await adapter.prepare({offer:{instruction:'hello'},descriptor:adapter.descriptor,requiredToolsetIds:[]});
    if (prepared.kind !== 'prepared') throw new Error(prepared.reason);
    const scratch = await testExecutionScratch();
    try {
      const runtimeLaunch = await prepared.operation.resolveRuntimeLaunch!({kind:'prepared',cwd:root,env:process.env,scratch});
      const manifest = sealRuntimeOperationManifest({
        taskId:'restricted',runtimeId:'pi',descriptor:adapter.descriptor,requiredToolsetIds:[],
        cwd:root,agentRef:{agentId:'restricted',profileRevision:'r1'},lease:{leaseId:'lease',canonicalHome:root},
        workspace:{workspaceDir:root},forwardedEnvironmentNames:[],
      });
      await expect(prepared.operation.start({kind:'prepared',scratch,runtimeLaunch,manifest,env:process.env,preparation:{} as never}))
        .rejects.toThrow('Pi Agent tool policy is supported only by the ordinary RPC lane');
      expect(spawned).toBe(false);
    } finally { await scratch.release(); }
  });
});
