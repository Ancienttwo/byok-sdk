import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as realSpawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter, type PiAdapterOptions } from '../adapters/pi/pi-adapter';
import { parsePiAgentResources } from '../adapters/pi/agent-resources';
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

describe('Pi Agent resources', () => {
  it.each([
    { agentUserContext:'excluded', agentSkillPaths:[path.resolve('approved-skill')], agentExtensionPaths:[path.resolve('approved.ts')] },
    { agentUserContext:'inherit' },
  ] satisfies PiAdapterOptions[])('seals explicit resources only for Agent operations: %j', async (options) => {
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
    expect(configs.map(config=>config.version)).toEqual([8,8]);
    expect(configs[0]).toMatchObject({agentUserContext:'inherit',agentSkillPaths:[],agentExtensionPaths:[]});
    expect(configs[1]).toMatchObject({agentUserContext:options.agentUserContext,agentSkillPaths:options.agentSkillPaths ?? [],agentExtensionPaths:options.agentExtensionPaths ?? []});
    for (const config of configs) expect(config).not.toHaveProperty('agentToolPolicy');
  });

  it('copies explicit resource grants and binds them into the launch digest', () => {
    const skillPaths = [path.resolve('approved-skill')];
    const extensionPaths = [path.resolve('approved-extension.ts')];
    const resources = parsePiAgentResources({userContext:'excluded',skillPaths,extensionPaths});
    skillPaths.push(path.resolve('unselected-skill'));
    extensionPaths.length = 0;
    expect(resources.skillPaths).toEqual([path.resolve('approved-skill')]);
    expect(resources.extensionPaths).toEqual([path.resolve('approved-extension.ts')]);
    expect(serializePiHostConfig(resources).digest).not.toBe(serializePiHostConfig({...resources,skillPaths:[]}).digest);
  });

  it.each([
    {agentUserContext:'excluded-ish'}, {agentUserContext:null},
    {agentSkillPaths:['relative']}, {agentSkillPaths:null},
    {agentExtensionPaths:['npm:unapproved']}, {agentExtensionPaths:[path.resolve('x'),path.resolve('x')]},
  ])('rejects invalid resource grants %j', options => {
    expect(()=>new PiAdapter(options as PiAdapterOptions)).toThrow('Pi Agent resources');
  });

  it.each([{agentUserContext:'excluded'}, {agentSkillPaths:[path.resolve('skill')]}, {agentExtensionPaths:[path.resolve('extension.ts')]}] satisfies PiAdapterOptions[])('refuses Agent resources %j on the prepared lane before spawning or reading its artifact', async options => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'byok-pi-unsupported-policy-')));
    roots.push(root);
    let spawned = false;
    const adapter = new PiAdapter({...options,resolveBin:()=>({command:FAKE_PI,source:'env'}),spawnFn:(()=>{spawned=true;throw new Error('unexpected spawn');}) as never});
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
        .rejects.toThrow('Pi Agent resources are supported only by the ordinary RPC lane');
      expect(spawned).toBe(false);
    } finally { await scratch.release(); }
  });
});
