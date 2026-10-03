import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync, realpathSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CONTROLLED_PI_DIRECTORY_ENV_NAMES, DESCENDANT_PER_LAUNCH_ENV_NAMES, PROVIDER_CREDENTIAL_ENV_DENY_NAMES,
  KEYS_PI_INHERITED_ENV_NAMES, KEYS_PI_WINDOWS_ENV_NAMES, loaderEnvInjections,
  reverifyToolImplementationIdentity, toolImplementationLaunchEnvNamesDigest, toolImplementationLoaderEnvValuesDigest,
  reverifyOfficialExternalCliDirectories, reverifyOfficialExternalCliDirectoriesSync, reverifyToolImplementationTuples,
  externalCliCommitment, parseDescendantLaunch, parseExternalCliDescendantLaunch,
  type AttestedOfficialExternalCliV2, type ExternalCliDescendantLaunchV2, type PiDescendantLaunchV2,
  type ToolImplementationFsProbe,
} from '@byok-sdk/implementation-identity';
import { buildRuntimeEnv } from '../daemon/environment';
import { claimCapSlot, countSlotFiles, safeKeySegment } from './custody-dispatcher';
import { CustodyDispatchRefusalError } from './external-cli-admission';
import { custodyExternalInstallations, EXTERNAL_INSTALLATIONS_METADATA_KEY, validateCustodyExternalInstallations, verifiedCustodyRunner } from './external-cli-authority';
import { loadCustodyLaunchRecord, BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV } from './custody-commitments';
import {
  claimRunFanoutBatchWithCommit, createWorkflowChildPermit, claimWorkflowChildPermit,
  consumeWorkflowChildPermit, decodeRunFanoutBudgetDescriptor, RUN_FANOUT_BUDGET_ENV,
  validateRunFanoutBudgetDescriptor,
  createOwnedProcessTreeController, type CustodyProcessTreeController,
  type RunFanoutBudgetDescriptor, type WorkflowChildPermit,
} from './custody-vendor-bridge.js';

const DENY = new Set<string>([
  ...PROVIDER_CREDENTIAL_ENV_DENY_NAMES, ...CONTROLLED_PI_DIRECTORY_ENV_NAMES, ...DESCENDANT_PER_LAUNCH_ENV_NAMES,
  'CODEX_API_KEY','CURSOR_API_KEY','CURSOR_AUTH_TOKEN','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','ANTHROPIC_BASE_URL','OPENAI_BASE_URL','OPENAI_ORG_ID',
  'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY',
  'AWS_PROFILE','AWS_DEFAULT_PROFILE','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','AZURE_CLIENT_SECRET',
  'GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','CLOUD_ML_REGION','BASH_ENV','ENV',
]);
const ALLOWED = new Set<string>([
  ...KEYS_PI_INHERITED_ENV_NAMES, ...KEYS_PI_WINDOWS_ENV_NAMES,
  'SSL_CERT_FILE','SSL_CERT_DIR','CODEX_HOME','CLAUDE_CONFIG_DIR',
]);
export function externalCliEnvironmentDenied(name: string): boolean {
  const n = name.toUpperCase();
  return n.startsWith('BYOK_') || DENY.has(n) || loaderEnvInjections({ [n]: 'present' }).length > 0;
}
/** Values supplied by adapters cannot widen either the bounded allowlist or hard deny. */
export function buildOfficialExternalCliEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  environment?: { readonly allowlist: readonly string[]; readonly values?: Readonly<Record<string,string>> },
  installation?: AttestedOfficialExternalCliV2,
): Record<string,string> {
  const baseline = buildRuntimeEnv({ ambient });
  const wanted = environment?.allowlist ?? Object.keys(baseline);
  const result: Record<string,string> = {};
  for (const name of wanted) {
    if (!ALLOWED.has(name) || externalCliEnvironmentDenied(name)) continue;
    const value = ambient[name];
    if (value !== undefined && !value.includes('\0')) result[name] = value;
  }
  for (const [name,value] of Object.entries(environment?.values ?? {})) {
    if (externalCliEnvironmentDenied(name) || !ALLOWED.has(name) || !wanted.includes(name)) refuse('external_cli_env_override_forbidden');
    if (name === 'HOME' || name === 'CODEX_HOME' || name === 'CLAUDE_CONFIG_DIR' || name === 'USERPROFILE') refuse('external_cli_config_override_forbidden');
    if (value.includes('\0')) refuse('external_cli_env_invalid');
    result[name] = value;
  }
  if (installation) {
    result.HOME = installation.homeDir;
    if (process.platform === 'win32') result.USERPROFILE = installation.homeDir;
    if (installation.adapter.startsWith('codex-')) result.CODEX_HOME = installation.configDir;
    else result.CLAUDE_CONFIG_DIR = installation.configDir;
  }
  return result;
}
function refuse(code: string): never { throw new CustodyDispatchRefusalError(code); }
export interface ExternalCliInvocation {
  readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly prompt: string;
}
export interface ExternalCliLaunchRequest extends ExternalCliInvocation {
  readonly adapter?: string; readonly operation: string; readonly attempt: number; readonly stepIndex: number;
  readonly environment?: { readonly allowlist: readonly string[]; readonly values?: Readonly<Record<string,string>> };
  readonly asyncDir?: string;
}
export interface ExternalCliAdmissionControl { readonly signal?: AbortSignal; readonly deadlineAt?: number }
export interface ExternalCliAuthorization {
  readonly record: ExternalCliDescendantLaunchV2;
  readonly env: Readonly<Record<string,string>>;
}
interface AuthorizationState {
  readonly authority: ExternalCliCustodyAuthority;
  readonly request: ExternalCliLaunchRequest;
  readonly control: ExternalCliAdmissionControl;
  readonly outputScope: OutputScope;
  consumed: boolean;
}
interface OutputScope { readonly root: string; readonly resolvedRoot: string; readonly directoryDigest: string; readonly file?: string }
interface ExternalLedger {
  version: 2; launchId: string; kind: 'probe' | 'task'; parent: string; operation: string; attempt: number;
  writer: boolean; depth: number; state: 'not-spawned' | 'spawned' | 'terminated' | 'uncertain'; pid?: number;
  slots: string[]; record?: ExternalCliDescendantLaunchV2;
}
function alive(pid: number): boolean {
  try { process.kill(pid,0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
const authorizationStates = new WeakMap<object,AuthorizationState>();
const processTrees = new WeakMap<object,CustodyProcessTreeController>();
const settlements = new WeakMap<object,Promise<void>>();
function groupAbsent(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try { process.kill(-pid,0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** Authority is constructed from the verified runner, never the submitted step. */
export class ExternalCliCustodyAuthority {
  private readonly parent: PiDescendantLaunchV2;
  private readonly parentDigest: string;
  private readonly installations: readonly AttestedOfficialExternalCliV2[];
  private readonly prepared = new Map<string,Promise<ExternalCliAuthorization>>();
  constructor(
    parent: PiDescendantLaunchV2,
    private readonly budget: RunFanoutBudgetDescriptor,
    installations: readonly AttestedOfficialExternalCliV2[],
    private readonly ambient: Readonly<Record<string,string | undefined>>,
    private readonly probe?: ToolImplementationFsProbe,
    private readonly parentRecordPath?: string,
  ) {
    this.budget = validateRunFanoutBudgetDescriptor(budget);
    this.parent = parseDescendantLaunch(parent);
    if (typeof this.parent.perLaunch.mcp.metadata['byok.custody.launchId'] !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(this.parent.perLaunch.mcp.metadata['byok.custody.launchId'] as string)) refuse('external_cli_parent_instance_required');
    const parentBudget = decodeRunFanoutBudgetDescriptor(this.parent.perLaunch.envValues[RUN_FANOUT_BUDGET_ENV] ?? undefined);
    if (this.parent.perLaunch.templateKind !== 'pi-subagent-runner' || this.parent.perLaunch.rootTaskId !== budget.rootRunId
      || this.parent.perLaunch.effectiveLimits.fanout > budget.limit || !parentBudget
      || externalCliCommitment(parentBudget) !== externalCliCommitment(this.budget)) refuse('external_cli_parent_binding_invalid');
    this.parentDigest = externalCliCommitment(this.parent);
    if (externalCliCommitment(installations) !== externalCliCommitment(this.parent.perLaunch.mcp.metadata[EXTERNAL_INSTALLATIONS_METADATA_KEY] ?? [])) refuse('external_cli_installation_parent_mismatch');
    this.installations = validateCustodyExternalInstallations(installations);
    this.ambient = Object.freeze({...ambient});
  }
  prepare(request: ExternalCliLaunchRequest, control: ExternalCliAdmissionControl = {}): Promise<ExternalCliAuthorization> {
    this.checkControl(control);
    if (!Number.isSafeInteger(request.attempt) || request.attempt < 0 || !Number.isSafeInteger(request.stepIndex)
      || request.stepIndex < 0 || !request.operation || !path.isAbsolute(request.cwd)) refuse('external_cli_request_invalid');
    const key = externalCliCommitment([request.operation,request.attempt]);
    const existing = this.prepared.get(key);
    if (existing) return existing.then(auth => {
      const state = authorizationStates.get(auth)!;
      if (control.signal !== state.control.signal || control.deadlineAt !== state.control.deadlineAt
        || externalCliCommitment(request) !== externalCliCommitment(state.request)) refuse('external_cli_attempt_replay_mismatch');
      return auth;
    });
    const frozen = JSON.parse(JSON.stringify(request)) as ExternalCliLaunchRequest;
    const pending = this.prepareOnce(frozen,Object.freeze({...control}));
    this.prepared.set(key,pending);
    return pending;
  }
  private async reverify(installation: AttestedOfficialExternalCliV2, env: Readonly<Record<string,string>>): Promise<void> {
    if (!await reverifyOfficialExternalCliDirectories(installation)) refuse('external_cli_config_directory_changed');
    this.reverifyParentRecord();
    // Identity measurement belongs to the installation; env projection is freshly sealed per launch.
    const identity = { ...installation.identity,
      launchEnvNamesDigest: toolImplementationLaunchEnvNamesDigest(env),
      loaderEnvValuesDigest: toolImplementationLoaderEnvValuesDigest(env) };
    const verdict = await reverifyToolImplementationIdentity(identity,env,this.probe);
    if (verdict !== 'ok') refuse(`external_cli_identity_${verdict.reason}`);
  }
  private reverifyParentRecord(): void {
    if (this.parentRecordPath) {
      let actual: unknown;
      try { actual = JSON.parse(readFileSync(this.parentRecordPath,'utf8')); } catch { refuse('external_cli_parent_record_changed'); }
      if (externalCliCommitment(actual) !== this.parentDigest) refuse('external_cli_parent_record_changed');
    }
  }
  private reverifyLocked(installation: AttestedOfficialExternalCliV2): void {
    if (!reverifyOfficialExternalCliDirectoriesSync(installation)) refuse('external_cli_config_directory_changed');
    this.reverifyParentRecord();
    const verdict = reverifyToolImplementationTuples(installation.identity,this.probe);
    if (verdict !== 'ok') refuse(`external_cli_identity_${verdict.reason}`);
  }
  private ledgers(): ExternalLedger[] {
    const dir = path.join(this.budget.directory,'custody-external');
    let names: string[];
    try { names = readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    return names.filter(n => n.endsWith('.json')).map(n => {
      const value = JSON.parse(readFileSync(path.join(dir,n),'utf8')) as ExternalLedger;
      if (value.version !== 2 || !Array.isArray(value.slots) || !['probe','task'].includes(value.kind)) refuse('external_cli_ledger_invalid');
      return value;
    });
  }
  private ledgerPath(id: string): string { return path.join(this.budget.directory,'custody-external',`${id}.json`); }
  /** One policy for advisory preflight and authoritative final locked admission. */
  private taskAdmissionDepth(tasks: readonly ExternalLedger[], task: { parent: string; operation: string; attempt: number; writer: boolean; stepIndex: number }): number {
    if (tasks.some(v => v.parent === task.parent && v.operation === task.operation && v.attempt === task.attempt)) refuse('external_cli_attempt_already_launched');
    const E = Math.min(this.parent.perLaunch.effectiveLimits.fanout,16), W = Math.min(E,4);
    if (tasks.length >= E) refuse('external_cli_E_exhausted');
    if (task.writer && tasks.filter(v => v.writer).length >= W) refuse('external_cli_W_exhausted');
    const handedOff = task.stepIndex !== 0 || task.attempt !== 0 || tasks.some(v => v.parent === this.parentDigest);
    const depth = this.parent.perLaunch.depth + (handedOff ? 1 : 0);
    if (depth > this.parent.perLaunch.effectiveLimits.maxDepth) refuse('external_cli_depth_exhausted');
    return depth;
  }
  private preflight(request: ExternalCliLaunchRequest, installation: AttestedOfficialExternalCliV2): void {
    claimRunFanoutBatchWithCommit(this.budget,[],() => {
      this.reverifyParentRecord();
      this.taskAdmissionDepth(this.ledgers().filter(v=>v.kind==='task'),{parent:this.parentDigest,operation:request.operation,attempt:request.attempt,
        writer:installation.adapter.endsWith('-writer'),stepIndex:request.stepIndex});
    });
  }
  private captureOutputScope(install: AttestedOfficialExternalCliV2, request: ExternalCliLaunchRequest): OutputScope {
    const root = request.asyncDir;
    if (!root || !path.isAbsolute(root) || path.normalize(root) !== root) refuse('external_cli_output_scope_required');
    let file: string | undefined;
    if (install.adapter.startsWith('codex-')) {
      file = path.join(root,`external-${request.stepIndex}.final-message.txt`);
      if (request.args[request.args.indexOf('--output-last-message')+1] !== file) refuse('external_cli_output_scope_mismatch');
    }
    try {
      const resolvedRoot = realpathSync(root), stat = lstatSync(resolvedRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('external_cli_output_scope_changed');
      const scope = Object.freeze({root,resolvedRoot,file,directoryDigest:externalCliCommitment([stat.dev,stat.ino,stat.mode,stat.uid,stat.gid])});
      this.reverifyOutputScope(scope); return scope;
    } catch { refuse('external_cli_output_scope_changed'); }
  }
  private reverifyOutputScope(scope: OutputScope): void {
    try {
      const resolved = realpathSync(scope.root), stat = lstatSync(resolved);
      if (resolved !== scope.resolvedRoot || !stat.isDirectory() || stat.isSymbolicLink()
        || externalCliCommitment([stat.dev,stat.ino,stat.mode,stat.uid,stat.gid]) !== scope.directoryDigest) refuse('external_cli_output_scope_changed');
      if (scope.file) {
        if (realpathSync(path.dirname(scope.file)) !== scope.resolvedRoot) refuse('external_cli_output_scope_changed');
        try { const leaf = lstatSync(scope.file); if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) refuse('external_cli_output_scope_changed'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } catch { refuse('external_cli_output_scope_changed'); }
  }
  /** Every managed physical process takes a root claim. All adapters share this table and these slots. */
  private commit<T>(ledger: ExternalLedger, launch: () => T, beforeLaunch?: () => void): T {
    const created: string[] = [];
    let result!: T;
    let launchError: unknown;
    let launchFailed = false;
    try {
      claimRunFanoutBatchWithCommit(this.budget,[`external/${ledger.launchId}`],() => {
        const previous = this.ledgers();
        // Confirmed dead PID only; no timeout-based release of live/uncertain children.
        for (const old of previous) {
          if ((old.state === 'spawned' || old.state === 'uncertain') && old.pid !== undefined && !alive(old.pid) && groupAbsent(old.pid)) {
            for (const slot of old.slots) {
              try { if (JSON.parse(readFileSync(slot,'utf8')).launchId === old.launchId) rmSync(slot,{force:true}); }
              catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            }
            old.state = 'terminated';
            writeFileSync(this.ledgerPath(old.launchId),JSON.stringify(old),{mode:0o600});
          }
        }
        const tasks = previous.filter(v => v.kind === 'task');
        if (ledger.kind === 'task') {
          ledger.depth = this.taskAdmissionDepth(tasks,{parent:ledger.parent,operation:ledger.operation,attempt:ledger.attempt,writer:ledger.writer,stepIndex:ledger.record!.stepIndex});
        }
        const limits = this.parent.perLaunch.effectiveLimits;
        const rootKey = safeKeySegment(this.budget.rootRunId);
        const sessionKey = safeKeySegment(this.parent.perLaunch.envValues.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID
          ?? this.parent.perLaunch.envValues.PI_SUBAGENT_PARENT_SESSION ?? this.parent.perLaunch.session.root);
        const slots: [string,number,string][] = [
          [path.join(this.budget.directory,'custody-caps','session',sessionKey),limits.sessionCap,'session'],
          [path.join(this.budget.directory,'custody-caps','parallel',rootKey),Math.min(limits.parallel,4),'parallel'],
          [path.join(this.budget.directory,'custody-caps','external',rootKey),Math.min(limits.parallel,2),'Q'],
          ...(ledger.writer ? [[path.join(this.budget.directory,'custody-caps','writer',rootKey),1,'J'] as [string,number,string]] : []),
        ];
        for (const [directory,limit,name] of slots) {
          if (countSlotFiles(directory) >= limit) refuse(`external_cli_${name}_exhausted`);
          const slot = claimCapSlot(directory,limit,created);
          writeFileSync(slot,JSON.stringify({launchId:ledger.launchId,pid:process.pid}),{mode:0o600});
          ledger.slots.push(slot);
        }
        if (ledger.record) ledger.record = { ...ledger.record, depth: ledger.depth };
        mkdirSync(path.dirname(this.ledgerPath(ledger.launchId)),{recursive:true,mode:0o700});
        writeFileSync(this.ledgerPath(ledger.launchId),JSON.stringify(ledger),{flag:'wx',mode:0o600});
        created.push(this.ledgerPath(ledger.launchId));
        beforeLaunch?.(); // Proven pre-spawn failures roll back every reservation.
        // Once launch is attempted, cumulative claims stay even if spawn throws.
        // Catch inside the lock callback so the fanout helper cannot refund them.
        try { result = launch(); } catch (e) { launchFailed = true; launchError = e; }
      });
    } catch (e) { for (const file of created.reverse()) rmSync(file,{force:true}); throw e; }
    // Native spawn throws synchronously before returning a child, or returns
    // one with a PID. Capture that PID before any fallible post-spawn setup.
    // Keep cumulative claims once native launch is attempted, but retain live
    // slots only when a child may exist.
    if (launchFailed) {
      // Setup may fail before a tree/listener exists. The PID was already
      // captured, and every POSIX child is detached into its own group.
      // Stop the entire group, but do not release slots on a signal attempt.
      if (ledger.pid !== undefined) { try { process.kill(-ledger.pid,'SIGTERM'); } catch {} }
      this.finish(ledger, ledger.pid !== undefined);
      throw launchError;
    }
    return result;
  }
  private finish(ledger: ExternalLedger, uncertain = false): void {
    claimRunFanoutBatchWithCommit(this.budget,[],() => {
      if (!uncertain) for (const slot of ledger.slots) {
        try { if (JSON.parse(readFileSync(slot,'utf8')).launchId === ledger.launchId) rmSync(slot,{force:true}); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      ledger.state = uncertain ? 'uncertain' : ledger.pid === undefined ? 'not-spawned' : 'terminated';
      writeFileSync(this.ledgerPath(ledger.launchId),JSON.stringify(ledger),{mode:0o600});
    });
  }
  private checkControl(control: ExternalCliAdmissionControl): void {
    if (process.platform === 'win32') refuse('external_cli_platform_unavailable');
    if (control.signal?.aborted) refuse('external_cli_cancelled');
    if (control.deadlineAt !== undefined && (!Number.isFinite(control.deadlineAt) || control.deadlineAt <= Date.now())) refuse('external_cli_deadline_exceeded');
  }
  private async runProbe(installation: AttestedOfficialExternalCliV2, args: readonly string[], env: Record<string,string>, cwd: string, control: ExternalCliAdmissionControl): Promise<string> {
    this.checkControl(control);
    await this.reverify(installation,env);
    this.checkControl(control);
    const ledger: ExternalLedger = { version:2,launchId:randomUUID(),kind:'probe',parent:this.parentDigest,
      operation:'probe',attempt:0,writer:false,depth:this.parent.perLaunch.depth,state:'uncertain',slots:[] };
    const child = this.commit(ledger,() => {
      const child = nodeSpawn(installation.identity.interpreter?.path ?? installation.identity.installPath,
        [...(installation.identity.interpreter ? [installation.identity.installPath] : []),...args],
        {cwd,env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform !== 'win32'});
      if (child.pid !== undefined) { ledger.pid=child.pid;ledger.state='spawned'; }
      child.on('error',()=>{});
      try { writeFileSync(this.ledgerPath(ledger.launchId),JSON.stringify(ledger),{mode:0o600}); }
      catch (error) { child.kill('SIGKILL'); throw error; }
      return child;
    },() => { this.checkControl(control); this.reverifyLocked(installation); this.checkControl(control); });
    // The admission lock covers claim/spawn/receipt only. Waiting and bounded output
    // collection happen outside it, so another process can use the second Q slot.
    const result = await new Promise<{status:number|null;output:string;failed:boolean}>(resolve => {
      const chunks: Buffer[]=[];let bytes=0;let failed=false;
      const stop = () => {
        failed=true;
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
      };
      const timeout = setTimeout(stop,Math.min(5000,control.deadlineAt === undefined ? 5000 : Math.max(0,control.deadlineAt-Date.now())));
      control.signal?.addEventListener('abort',stop,{once:true});
      const collect = (chunk: Buffer) => { bytes+=chunk.length;if(bytes>256*1024)stop();else chunks.push(chunk); };
      child.stdout!.on('data',collect);child.stderr!.on('data',collect);
      child.once('error',()=>{failed=true;});
      child.once('close',status=>{clearTimeout(timeout);control.signal?.removeEventListener('abort',stop);resolve({status,output:Buffer.concat(chunks).toString('utf8').trim(),failed});});
      if (control.signal?.aborted) stop();
    });
    const tree = child.pid === undefined ? undefined : createOwnedProcessTreeController(child.pid,{observation:'kernel-presence',termGraceMs:2000});
    const terminal = tree ? await tree.finishAfterWriterClose() : undefined;
    this.finish(ledger,terminal !== undefined && terminal.state !== 'observed');
    if (terminal?.state === 'unknown') refuse('external_cli_probe_quiescence_unavailable');
    this.checkControl(control);
    if (result.failed || result.status !== 0) refuse('external_cli_probe_unavailable');
    return result.output;
  }
  private async prepareOnce(request: ExternalCliLaunchRequest, control: ExternalCliAdmissionControl): Promise<ExternalCliAuthorization> {
    const install = this.installations.find(v => v.adapter === request.adapter);
    if (!install) refuse('external_cli_installation_unavailable');
    const expectedCommand = install.identity.interpreter?.path ?? install.identity.installPath;
    if (request.command !== expectedCommand) refuse('external_cli_command_mismatch');
    const env = buildOfficialExternalCliEnvironment(this.ambient,request.environment,install);
    if (install.identity.interpreter && request.args[0] !== install.identity.installPath) refuse('external_cli_entry_mismatch');
    const args = install.identity.interpreter ? request.args.slice(1) : request.args;
    validateOfficialExternalCliArgv(install,args);
    const outputScope = this.captureOutputScope(install,request);
    this.preflight(request,install);
    const probeHome = mkdtempSync(path.join(os.tmpdir(),'byok-cli-probe-'));
    const probeEnv = buildOfficialExternalCliEnvironment(this.ambient);
    probeEnv.HOME = probeHome;
    probeEnv.USERPROFILE = probeHome;
    delete probeEnv.CODEX_HOME; delete probeEnv.CLAUDE_CONFIG_DIR;
    let help: string;
    try {
      const version = await this.runProbe(install,['--version'],probeEnv,probeHome,control);
      if (!(install.adapter.startsWith('codex-') ? /^codex-cli \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u
        : /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)? \(Claude Code\)$/u).test(version)) refuse('external_cli_version_unavailable');
      help = await this.runProbe(install,install.adapter.startsWith('codex-') ? ['exec','--help'] : ['--help'],probeEnv,probeHome,control);
    } finally { rmSync(probeHome,{recursive:true,force:true}); }
    const required = install.adapter.startsWith('codex-')
      ? ['--ignore-user-config','--ignore-rules','--sandbox','--config','--ephemeral']
      : ['--tools','--strict-mcp-config','--mcp-config','--setting-sources','--settings','--disable-slash-commands'];
    if (required.some(flag => !help.includes(flag))) refuse('external_cli_restriction_unavailable');
    await this.verifyLoginMode(install,env,request.cwd,control);
    const record: ExternalCliDescendantLaunchV2 = {
      format:'byok.descendant-launch',version:2,target:'official-external-cli',
      edge:{parent:'pi-subagent-runner',child:'official-external-cli',inheritsCredential:false},
      installation:install,rootTaskId:this.budget.rootRunId,parentRecordDigest:this.parentDigest,
      policyDigest:externalCliCommitment(this.parent.policy),operation:request.operation,attempt:request.attempt,
      stepIndex:request.stepIndex,
      depth:this.parent.perLaunch.depth,launchId:randomUUID(),invocationDigest:externalCliCommitment({command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env}),
      launchEnvNamesDigest:toolImplementationLaunchEnvNamesDigest(env),loaderEnvValuesDigest:toolImplementationLoaderEnvValuesDigest(env),
    };
    const parsed = parseExternalCliDescendantLaunch(record);
    if (!parsed) refuse('external_cli_record_invalid');
    const authorization = Object.freeze({record:parsed,env:Object.freeze(env)});
    authorizationStates.set(authorization,{authority:this,request,control,outputScope,consumed:false});
    return authorization;
  }
  /** CLI-produced mode evidence; bounded/charged like every other native probe. */
  private async verifyLoginMode(install: AttestedOfficialExternalCliV2, env: Record<string,string>, cwd: string, control: ExternalCliAdmissionControl): Promise<void> {
    const auth = await this.runProbe(install,install.adapter.startsWith('codex-')
      ? ['login','status'] // exec-only flags do not belong to the login command.
      : ['--setting-sources','','auth','status'],env,cwd,control);
    if (!officialExternalCliLoginProven(install.adapter,auth)) refuse('external_cli_auth_mode_unavailable');
    if (install.adapter.startsWith('claude-') && JSON.parse(auth).configDirectory !== install.configDir) refuse('external_cli_config_scope_unavailable');
  }
  /** Final remeasurement, binding, atomic claim and permit consume immediately precede spawn. */
  async spawn(authorization: ExternalCliAuthorization, actual: ExternalCliInvocation & { readonly env: Readonly<Record<string,string>> }): Promise<ChildProcessWithoutNullStreams> {
    const state = authorizationStates.get(authorization);
    if (!state || state.authority !== this || state.consumed) refuse('external_cli_permit_reused');
    this.checkControl(state.control);
    const record = parseExternalCliDescendantLaunch(authorization.record);
    if (!record || record.parentRecordDigest !== this.parentDigest || record.rootTaskId !== this.budget.rootRunId
      || record.policyDigest !== externalCliCommitment(this.parent.policy)) refuse('external_cli_record_binding_mismatch');
    if (externalCliCommitment(actual) !== record.invocationDigest) refuse('external_cli_invocation_changed');
    if (toolImplementationLaunchEnvNamesDigest(actual.env) !== record.launchEnvNamesDigest
      || toolImplementationLoaderEnvValuesDigest(actual.env) !== record.loaderEnvValuesDigest) refuse('external_cli_env_changed');
    // No general install-version capability is attested for a mode-lock setting.
    // Re-prove Claude's own-login state at every final admission instead; then
    // remeasure bytes/parent/env again. A same-UID final check/spawn race remains.
    if (record.installation.adapter.startsWith('claude-')) {
      // Avoid an unnecessary final status probe; all adapters still use final
      // locked admission after the complete physical reverify.
      this.preflight(state.request,record.installation);
      await this.verifyLoginMode(record.installation,{...actual.env},actual.cwd,state.control);
    }
    await this.reverify(record.installation,actual.env);
    if (state.consumed) refuse('external_cli_permit_reused');
    this.checkControl(state.control);
    const ledger: ExternalLedger = {version:2,launchId:record.launchId,kind:'task',parent:this.parentDigest,
      operation:record.operation,attempt:record.attempt,writer:record.installation.adapter.endsWith('-writer'),
      depth:record.depth,state:'uncertain',slots:[],record};
    return this.commit(ledger,() => {
      const child = nodeSpawn(actual.command,[...actual.args],{cwd:actual.cwd,env:{...actual.env},
        stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform !== 'win32'}) as ChildProcessWithoutNullStreams;
      if (child.pid !== undefined) { ledger.pid = child.pid; ledger.state = 'spawned'; }
      child.on('error',() => {});
      const tree = child.pid === undefined ? undefined : createOwnedProcessTreeController(child.pid,{observation:'kernel-presence',termGraceMs:2000});
      if (tree) processTrees.set(child,tree);
      const abort = () => { if (tree) void tree.terminate(); };
      state.control.signal?.addEventListener('abort',abort,{once:true});
      settlements.set(child,new Promise<void>((resolve,reject) => child.once('close',() => {
        state.control.signal?.removeEventListener('abort',abort);
        void (async () => {
          const terminal = tree ? await tree.finishAfterWriterClose() : undefined;
          this.finish(ledger,terminal !== undefined && terminal.state !== 'observed');
          if (terminal?.state === 'unknown') refuse('external_cli_process_tree_unconfirmed');
        })().then(resolve,reject);
      })));
      try { writeFileSync(this.ledgerPath(ledger.launchId),JSON.stringify(ledger),{mode:0o600}); }
      catch (error) { child.kill('SIGTERM'); throw error; }
      return child;
    },() => {
      this.checkControl(state.control);
      this.reverifyLocked(record.installation);
      this.checkControl(state.control);
      this.reverifyOutputScope(state.outputScope);
      if (state.outputScope.file) rmSync(state.outputScope.file,{force:true});
      // Consume failure cannot create a child. Mark the handle monotonic before native spawn.
      state.consumed = true;
      const finalRecord = ledger.record!;
      const permit = createWorkflowChildPermit({issuerPackage:'@byok-sdk/client',workflowRunId:record.rootTaskId,
        childKey:record.launchId,agent:record.installation.adapter,launchContractDigest:externalCliCommitment(finalRecord),context:'fresh',runner:'official-external-cli'});
      const claimError = claimWorkflowChildPermit(permit,record.rootTaskId,record.launchId);
      if (claimError) refuse('external_cli_permit_invalid');
      const error = consumeWorkflowChildPermit(permit,{workflowRunId:record.rootTaskId,childKey:record.launchId,
        agent:record.installation.adapter,launchContractDigest:externalCliCommitment(finalRecord),context:'fresh',runner:'official-external-cli'});
      if (error) refuse('external_cli_permit_reused');
    });
  }
  processTreeFor(child: ChildProcessWithoutNullStreams): CustodyProcessTreeController | undefined { return processTrees.get(child); }
  settled(child: ChildProcessWithoutNullStreams): Promise<void> { return settlements.get(child) ?? Promise.resolve(); }
}

export function officialExternalCliLoginProven(adapter: string, output: string): boolean {
  if (adapter.startsWith('codex-')) return output === 'Logged in using ChatGPT';
  if (!adapter.startsWith('claude-')) return false;
  try {
    const status = JSON.parse(output) as Record<string,unknown>;
    return status.loggedIn === true && status.authMethod === 'claude.ai'
      && status.apiProvider === 'firstParty' && status.apiKeySource === null
      && ['pro','max','team','enterprise'].includes(String(status.subscriptionType));
  } catch { return false; }
}
const CODEX_RESTRICTIONS = [
  'approval_policy="never"','forced_login_method="chatgpt"','model_provider="openai"',
  'model_providers={}','agents.enabled=false','features.multi_agent=false','features.hooks=false','features.plugins=false','mcp_servers={}',
] as const;
/** Full finite grammar: extra arguments/config/backend/key helpers all refuse. */
export function validateOfficialExternalCliArgv(install: AttestedOfficialExternalCliV2, args: readonly string[]): void {
  const writer = install.adapter.endsWith('-writer');
  if (install.adapter.startsWith('codex-')) {
    const prefix = ['exec','--json','--color','never','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','-s',writer ? 'workspace-write' : 'read-only',
      ...CODEX_RESTRICTIONS.flatMap(v => ['-c',v]),'--output-last-message'];
    if (args.length !== prefix.length + 2 || prefix.some((v,i) => v !== args[i]) || !path.isAbsolute(args[prefix.length]!) || args.at(-1) !== '-') refuse('external_cli_argv_override_forbidden');
  } else if (install.adapter.startsWith('claude-')) {
    const expected = ['-p','--input-format','text','--output-format','stream-json','--verbose','--permission-mode',writer ? 'acceptEdits' : 'plan',
      '--tools',writer ? 'Read,Write,Edit,Glob,Grep' : '', '--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
      '--setting-sources','','--settings','{"apiKeyHelper":"","disableAllHooks":true}',
      '--no-session-persistence','--disable-slash-commands','--no-chrome'];
    if (externalCliCommitment(args) !== externalCliCommitment(expected)) refuse('external_cli_argv_override_forbidden');
  } else refuse('external_cli_auth_mode_unavailable');
}
export const OFFICIAL_CODEX_RESTRICTIONS = CODEX_RESTRICTIONS;
let authority: ExternalCliCustodyAuthority | undefined;
const attempts = new Map<string,number>();
export function currentExternalCliCustodyAuthority(): ExternalCliCustodyAuthority {
  if (authority) return authority;
  if (!process.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]) refuse('external_cli_verified_runner_required');
  const parent = verifiedCustodyRunner();
  if (!parent) refuse('external_cli_verified_runner_required');
  if (externalCliCommitment(loadCustodyLaunchRecord(process.env)) !== externalCliCommitment(parent)) refuse('external_cli_parent_record_changed');
  const budget = decodeRunFanoutBudgetDescriptor(process.env[RUN_FANOUT_BUDGET_ENV]);
  if (!budget) refuse('external_cli_root_budget_required');
  authority = new ExternalCliCustodyAuthority(parent,budget,custodyExternalInstallations(),process.env,undefined,process.env[BYOK_SDK_CUSTODY_LAUNCH_RECORD_ENV]);
  return authority;
}
export function nextExternalCliAttempt(asyncDir: string, stepIndex: number): {operation:string;attempt:number;stepIndex:number} {
  const operation = externalCliCommitment([path.resolve(asyncDir),stepIndex]);
  const attempt = attempts.get(operation) ?? 0;
  attempts.set(operation,attempt+1);
  return {operation,attempt,stepIndex};
}
