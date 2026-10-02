import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync, mkdirSync, copyFileSync, chmodSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realToolImplementationFsProbe, resolveOfficialExternalCliInstall,
  type AttestedOfficialExternalCliV2, type OfficialExternalCliAdapter, type ToolImplementationFsProbe,
  type OfficialExternalCliInstallV2, type PiDescendantLaunchV2 } from '@byok-sdk/implementation-identity';
import { configureCustodyExternalInstallations } from '../../custody/external-cli-authority';
import { dispatchCustodyPiSubagentSpawn } from '../../custody/custody-dispatcher';
import { ExternalCliCustodyAuthority, type ExternalCliLaunchRequest } from '../../custody/external-cli-custody';
import { createRunFanoutBudget, encodeRunFanoutBudgetDescriptor, RUN_FANOUT_BUDGET_ENV } from '../../custody/custody-vendor-bridge.js';
export const SECRET = 'synthetic-sixth-edge-secret';
export const SECRET_NAMES = ['OPENAI_API_KEY','CODEX_API_KEY','CURSOR_API_KEY','ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS','NODE_OPTIONS','BYOK_SDK_CUSTODY_LAUNCH_RECORD','BYOK_UNKNOWN',
  'PI_SUBAGENT_RUN_FANOUT_BUDGET','PI_SUBAGENT_PARENT_CAPABILITY_TOKEN','PI_PROVIDER_API_KEY',
  'BYOK_SDK_CUSTODY_N1_PROBE','BYOK_SDK_CUSTODY_PARENT_DEPTH','BYOK_SDK_CUSTODY_RUNNER_CONFIG',
  'PI_SUBAGENT_PARENT_CONTROL_INBOX','PI_SUBAGENT_EXTENSION_BINDINGS','PI_CODING_AGENT_SESSION_DIR'];
export const ownershipProbe: ToolImplementationFsProbe = {
  ...realToolImplementationFsProbe,
  // Only ownership/mode are simulated. Inodes, paths, timestamps and bytes stay real.
  async lstat(target) { const stat = await realToolImplementationFsProbe.lstat(target); return {...stat,uid:0,mode:stat.mode & ~0o222}; },
};
const clientRoot = path.resolve(import.meta.dirname,'../../..');
export async function importVendor<T>(relative: string): Promise<T> {
  return await import(pathToFileURL(path.join(clientRoot,'vendor/pi-subagents/0.60.0/src',relative)).href) as T;
}
export async function sixthEdgeKit(options: { auth?: string; limit?: number; maxDepth?: number; hold?: boolean; family?: 'codex' | 'claude'; copyInterpreter?: boolean; native?: boolean; ignoreTerm?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(),'byok-sixth-')));
  const entry = path.join(dir,'official-fixture.mjs');
  const family = options.family ?? 'codex';
  const configDir = path.join(dir,'config'); mkdirSync(configDir,{mode:0o700});
  const statePath = path.join(dir,'auth-mode.json');
  writeFileSync(path.join(dir,'fixture-resource.txt'),'sealed-resource',{mode:0o444});
  writeFileSync(statePath,JSON.stringify({auth:options.auth ?? 'login'}));
  writeFileSync(entry,`
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(${JSON.stringify((options.family ?? 'codex') === 'codex' ? 'codex-cli 9.0.0' : '9.0.0 (Claude Code)')}); process.exit(0); }
if (args.includes('--help')) { console.log('--ignore-user-config --ignore-rules --sandbox --config --ephemeral --tools --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands'); process.exit(0); }
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));
if (args.includes('status')) { console.log(${JSON.stringify(options.family ?? 'codex')} === 'claude' ? JSON.stringify({loggedIn:true,authMethod:state.auth==='login'?'claude.ai':'api_key',apiProvider:'firstParty',apiKeySource:null,subscriptionType:'max',configDirectory:process.env.CLAUDE_CONFIG_DIR}) : state.auth === 'login' ? 'Logged in using ChatGPT' : state.auth === 'key' ? 'Logged in using an API key: ${SECRET}' : 'unknown ${SECRET}'); process.exit(0); }
let input=''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input+=chunk);
process.stdin.on('end', () => {
 const observed = Object.fromEntries(${JSON.stringify(SECRET_NAMES)}.map(name => [name,Object.hasOwn(process.env,name)]));
 const result = {args,observed,home:process.env.HOME,config:process.env.CODEX_HOME ?? process.env.CLAUDE_CONFIG_DIR};
 fs.appendFileSync(path.join(process.cwd(),'task-spawned.jsonl'),JSON.stringify(result)+'\\n');
 const outputIndex=args.indexOf('--output-last-message');
 if(outputIndex>=0)fs.writeFileSync(args[outputIndex+1],JSON.stringify(result));
 console.log(JSON.stringify(${JSON.stringify(options.family ?? 'codex')} === 'claude' ? {type:'result',subtype:'success',is_error:false,result:JSON.stringify(result)} : {type:'turn.completed'}));
 if (input==='hold') setInterval(()=>{},1000);
});
`,{mode:0o555});
  if (options.native) {
    const source=path.join(dir,'fixture.c');
    writeFileSync(source,`#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
int main(int argc,char **argv){
 for(int i=1;i<argc;i++){
  if(!strcmp(argv[i],"--version")){puts("${family === 'codex' ? 'codex-cli 9.0.0' : '9.0.0 (Claude Code)'}");return 0;}
  if(!strcmp(argv[i],"--help")){puts("--ignore-user-config --ignore-rules --sandbox --config --ephemeral --tools --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands");return 0;}
  if(!strcmp(argv[i],"status")){
  if(${family === 'claude' ? '1' : '0'})puts(${JSON.stringify(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',apiKeySource:null,subscriptionType:'max',configDirectory:configDir}))});
  else puts("Logged in using ChatGPT");return 0;
 }
 }
 if(${options.ignoreTerm ? '1' : '0'})signal(SIGTERM,SIG_IGN);
 FILE *ready=fopen("native-ready","w");if(ready){fputs("ready",ready);fclose(ready);}
 char c;while(read(0,&c,1)>0){}
 FILE *f=fopen("task-spawned.jsonl","a");if(!f)return 2;fputs("{}\\n",f);fclose(f);
 for(int i=1;i+1<argc;i++)if(!strcmp(argv[i],"--output-last-message")){f=fopen(argv[i+1],"w");if(!f)return 3;fputs("{}",f);fclose(f);}
 puts("{\\"type\\":\\"turn.completed\\"}");return 0;
}`);
    chmodSync(entry,0o755);
    const result=spawnSync('cc',[source,'-O2','-o',entry],{encoding:'utf8'});
    if(result.status!==0)throw Error(`native fixture compile failed: ${result.stderr}`);
    chmodSync(entry,0o555);
  }
  utimesSync(entry,1700000000,1700000000);
  let command = realpathSync(process.execPath);
  const copiedAssets: string[]=[];
  if (options.copyInterpreter) {
    const copied=path.join(dir,'node','bin','node');mkdirSync(path.dirname(copied),{recursive:true});
    const libraryDir=path.resolve(path.dirname(command),'../lib');
    if (existsSync(libraryDir)) for(const name of readdirSync(libraryDir).filter(n=>/^libnode.*\.(dylib|so(?:\..*)?)$/u.test(n))) {
      const relative=`node/lib/${name}`, target=path.join(dir,relative);mkdirSync(path.dirname(target),{recursive:true});
      copyFileSync(path.join(libraryDir,name),target);chmodSync(target,0o444);copiedAssets.push(relative);
    }
    copyFileSync(command,copied);chmodSync(copied,0o555);command=copied;
  }
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const declaration = (adapter: OfficialExternalCliAdapter): OfficialExternalCliInstallV2 => ({
    format:'byok.official-cli-install',version:2,adapter,sourceProofRef:'test:causal-cli-fixture',configProofRef:'test:fixture-config-scope',
    restriction: family === 'codex' ? 'codex-chatgpt-terminal-v1' : 'claude-subscription-terminal-v1',homeDir:dir,configDir,
    record:{kind:'attested',authority:'host-install-record',manifestRevision:'fixture-1',form:options.native ? 'compiled-executable' : 'interpreter+bundle',
      installPath:entry,closureDigest:hash(entry),closureKind:'artifact',
      ...(options.native ? {} : {interpreter:{path:command,digest:hash(command),loadCommandsDigest:createHash('sha256').update('[]').digest('hex')}}),
      launchArgv:[],launchCwd:dir,assetRoot:dir,assets:['fixture-resource.txt',...copiedAssets].sort().map(file=>({path:file,digest:hash(path.join(dir,file))}))},
  });
  const installations: AttestedOfficialExternalCliV2[] = [];
  for (const adapter of (family === 'codex' ? ['codex-exec','codex-exec-writer'] : ['claude-code','claude-code-writer']) as OfficialExternalCliAdapter[]) {
    const install = await resolveOfficialExternalCliInstall({resolve:async () => declaration(adapter)},adapter,ownershipProbe);
    if (!install) throw new Error('fixture installation did not attest');
    installations.push(install);
  }
  const budget = createRunFanoutBudget(`sixth-${randomUUID()}`,options.limit ?? 128);
  const oldEnv = {...process.env};
  try {
    delete process.env.BYOK_SDK_CUSTODY_LAUNCH_RECORD;
    process.env[RUN_FANOUT_BUDGET_ENV] = encodeRunFanoutBudgetDescriptor(budget);
    process.env.PI_CODING_AGENT_SESSION_DIR = dir;
    process.env.PI_SUBAGENT_MAX_DEPTH = String(options.maxDepth ?? 8);
    process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = '128';
    configureCustodyExternalInstallations(installations);
    const actualCommand=options.native ? entry : command;
    const config = path.join(dir,'runner-config.json');
    writeFileSync(config,JSON.stringify({steps:[{agent:'fixture',task:'task',runner:{type:'external-cli',adapter:installations[0]!.adapter,command:actualCommand}}]}));
    const dispatch = dispatchCustodyPiSubagentSpawn({child:'pi-subagent-runner',cwd:dir,runnerConfigPath:config});
    const parent = JSON.parse(readFileSync(dispatch.recordPath,'utf8')) as PiDescendantLaunchV2;
    const ambient = {...oldEnv,...Object.fromEntries(SECRET_NAMES.map(n => [n,SECRET]))};
    const authority = new ExternalCliCustodyAuthority(parent,budget,installations,ambient,ownershipProbe,dispatch.recordPath);
    const launch = await importVendor<{resolveCodexExecLaunch(input: {adapter:'codex-exec'|'codex-exec-writer';command:string;asyncDir:string;stepIndex:number;commandPrefixArgs:readonly string[]}): {command:string;args:string[];environment:{allowlist:readonly string[]}}}>('runs/shared/codex-exec-adapter.ts');
    const claudeLaunch = await importVendor<{resolveClaudeCodeLaunch(input: {adapter:'claude-code'|'claude-code-writer';command:string;commandPrefixArgs:readonly string[]}): {command:string;args:string[];environment:{allowlist:readonly string[]}}}>('runs/shared/claude-code-adapter.ts');
    let serial = 0;
    const request = (writer = false, operation?: string, attempt = 0, index?: number): ExternalCliLaunchRequest => {
      const stepIndex = index ?? serial++;
      const adapter = writer ? 'codex-exec-writer' : 'codex-exec';
      const claudeAdapter = writer ? 'claude-code-writer' : 'claude-code';
      const built = family === 'codex' ? launch.resolveCodexExecLaunch({adapter,command:actualCommand,asyncDir:dir,stepIndex,commandPrefixArgs:options.native ? [] : [entry]}) : claudeLaunch.resolveClaudeCodeLaunch({adapter:claudeAdapter,command:actualCommand,commandPrefixArgs:options.native?[]:[entry]});
      return {...built,adapter:family === 'codex' ? adapter : claudeAdapter,asyncDir:dir,cwd:dir,prompt:options.hold ? 'hold' : '',stepIndex,operation:operation ?? `step-${stepIndex}`,attempt};
    };
    return {dir,entry,command,config,configDir,statePath,budget,parent,installations,authority,request,declaration,recordPath:dispatch.recordPath,
      tasks: (): Record<string,unknown>[] => {try { return readFileSync(path.join(dir,'task-spawned.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(v => JSON.parse(v)); }catch {return [];}},
      dispose: () => {rmSync(dir,{recursive:true,force:true});rmSync(budget.directory,{recursive:true,force:true});},
    };
  } catch (e) { rmSync(dir,{recursive:true,force:true});rmSync(budget.directory,{recursive:true,force:true});throw e; }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env,oldEnv);
    configureCustodyExternalInstallations([]);
  }
}
