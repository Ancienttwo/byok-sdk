import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildOfficialExternalCliEnvironment } from '../custody/external-cli-custody';
import { sixthEdgeKit, SECRET_NAMES } from './fixtures/sixth-edge-kit';
import { once } from 'node:events';
import { CustodyDispatchRefusalError } from '../custody/custody-dispatcher';
import {
  EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX,
  externalCliCustodyRefusalReason,
  findExternalCliRunnerStep,
} from '../custody/external-cli-admission';

const clientRoot = path.resolve(import.meta.dirname, '../..');
// Use the existing computed-import boundary for vendored TS without declarations.
async function vendorImport<T>(relative: string): Promise<T> {
  return await import(pathToFileURL(path.join(clientRoot, 'vendor/pi-subagents/0.60.0/src', relative)).href) as T;
}

type Step = Record<string, unknown>;
interface AppendRequest { steps: Step[] }
const append = await vendorImport<{
  enqueueChainAppendRequest(input: { asyncDir: string; runId: string; steps: Step[]; now?: number }): unknown;
  consumeChainAppendRequests(asyncDir: string): AppendRequest[];
}>('runs/background/chain-append.ts');
const { runExternalCli } = await vendorImport<{
  runExternalCli(input: {
    command: string; args: string[]; cwd: string; prompt: string; asyncDir: string; stepIndex: number;
    environment?: { allowlist: readonly string[]; values?: Record<string, string> };
  }): Promise<{ exitCode: number | null; output: string }>;
}>('runs/shared/external-cli-runner.ts');

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'byok-n1-regression-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runningChain(): { asyncDir: string; runId: string } {
  const asyncDir = temporaryDirectory();
  const runId = 'n1-append-regression';
  writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({
    runId, mode: 'chain', state: 'running', steps: [{ agent: 'general', status: 'running' }],
  }));
  return { asyncDir, runId };
}
function externalStep(adapter?: string): Step {
  return { agent: 'probe', task: 'custody probe', runner: {
    type: 'external-cli', command: 'unused-external-cli', ...(adapter === undefined ? {} : { adapter }),
  } };
}

describe('running-chain append shares the initial external-cli typed refusal', () => {
  it.each([
    undefined, 'codex-exec', 'codex-exec-writer', 'claude-code', 'claude-code-writer',
    'cursor-agent', 'cursor-agent-writer', 'unrecognized-adapter',
  ])('refuses %s before returning executable steps', (adapter) => {
    const chain = runningChain();
    const steps = [externalStep(adapter)];
    const finding = findExternalCliRunnerStep({ steps });
    expect(finding).toEqual({ location: 'steps[0]', ...(adapter === undefined ? {} : { adapter }) });
    append.enqueueChainAppendRequest({ ...chain, steps });
    const requestPath = path.join(chain.asyncDir, 'append-requests', readdirSync(path.join(chain.asyncDir, 'append-requests'))[0]!);
    let caught: unknown;
    try { append.consumeChainAppendRequests(chain.asyncDir); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CustodyDispatchRefusalError);
    expect((caught as CustodyDispatchRefusalError).reason).toBe(externalCliCustodyRefusalReason(requestPath, finding!));
    expect((caught as Error).message).toContain(EXTERNAL_CLI_CUSTODY_REFUSAL_PREFIX);
    // A refused batch returns no steps and writes a terminal failure ack.
    expect(readdirSync(path.join(chain.asyncDir, 'append-requests'))).toHaveLength(0);
    expect(readdirSync(path.join(chain.asyncDir, 'append-acks'))).toHaveLength(1);
    expect(append.consumeChainAppendRequests(chain.asyncDir)).toEqual([]);
  });

  it.each([
    { parallel: [externalStep('claude-code')] },
    { parallel: externalStep('cursor-agent'), expand: { maxItems: 2 }, collect: { as: 'out' } },
  ])('refuses and acks the entire nested batch without accepting an earlier clean request', (group) => {
    const chain = runningChain();
    append.enqueueChainAppendRequest({ ...chain, steps: [{ agent: 'general', task: 'clean' }], now: 1 });
    append.enqueueChainAppendRequest({ ...chain, steps: [group], now: 2 });
    expect(() => append.consumeChainAppendRequests(chain.asyncDir)).toThrow(CustodyDispatchRefusalError);
    expect(readdirSync(path.join(chain.asyncDir, 'append-requests'))).toHaveLength(0);
    expect(readdirSync(path.join(chain.asyncDir, 'append-acks'))).toHaveLength(2);
    expect(append.consumeChainAppendRequests(chain.asyncDir)).toEqual([]);
  });

  it('continues to consume clean Pi steps once, in order', () => {
    const chain = runningChain();
    const steps = [{ agent: 'general', task: 'clean', runner: { type: 'pi' } }];
    append.enqueueChainAppendRequest({ ...chain, steps });
    expect(append.consumeChainAppendRequests(chain.asyncDir).flatMap(request => request.steps)).toEqual(steps);
    expect(append.consumeChainAppendRequests(chain.asyncDir)).toEqual([]);
  });
});

const privateNames = [
  'BYOK_SDK_CUSTODY_N1_PROBE', 'BYOK_SDK_CUSTODY_LAUNCH_RECORD', 'BYOK_SDK_CUSTODY_PARENT_DEPTH',
  'BYOK_SDK_CUSTODY_RUNNER_CONFIG', 'PI_SUBAGENT_RUN_FANOUT_BUDGET', 'PI_SUBAGENT_PARENT_CAPABILITY_TOKEN',
  'PI_SUBAGENT_PARENT_CONTROL_INBOX', 'PI_SUBAGENT_EXTENSION_BINDINGS', 'PI_PROVIDER_API_KEY',
  'PI_CODING_AGENT_SESSION_DIR',
];
function markPrivateEnvironment(): void {
  for (const name of privateNames) vi.stubEnv(name, 'synthetic-n1-sentinel');
}
async function childEnvironment(names: readonly string[], environment?: { allowlist: readonly string[]; values?: Record<string, string> }) {
  const k = await sixthEdgeKit();
  try {
    const request = { ...k.request(), ...(environment === undefined ? {} : { environment }) };
    const auth = await k.authority.prepare(request);
    const child = await k.authority.spawn(auth,{command:request.command,args:request.args,cwd:request.cwd,prompt:request.prompt,env:auth.env});
    const close = once(child,'close');child.stdin.end(request.prompt);await close; await k.authority.settled(child);
    expect(k.tasks()).toHaveLength(1);
    const observed = k.tasks()[0]!.observed as Record<string,boolean>;
    return Object.fromEntries(names.map(name => [name,name === 'HOME' ? typeof k.tasks()[0]!.home === 'string' : observed[name]]));
  } finally { k.dispose(); }
}

describe('external-cli environment isolation at the real child boundary', () => {
  it('bare/unrecognized launch is now refused before the child boundary', async () => {
    markPrivateEnvironment();
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-provider-key');
    const asyncDir = temporaryDirectory();
    await expect(runExternalCli({command:process.execPath,args:['-e',"throw Error('must not spawn')"],cwd:asyncDir,prompt:'',asyncDir,stepIndex:0}))
      .rejects.toThrow('custody');
    expect(readdirSync(asyncDir)).toEqual([]);
    const env = buildOfficialExternalCliEnvironment(process.env);
    expect([...privateNames,'OPENAI_API_KEY'].every(name => env[name] === undefined)).toBe(true);
  });

  it('refuses explicit custody value overrides instead of transmitting their values', async () => {
    markPrivateEnvironment();
    const values = Object.fromEntries(privateNames.map(name => [name,'synthetic-override']));
    expect(() => buildOfficialExternalCliEnvironment(process.env,{allowlist:privateNames,values})).toThrow('external_cli_env_override_forbidden');
  });

  it('strips credentials from the named Codex adapter at the real child boundary', async () => {
    const { CODEX_EXEC_ENV_ALLOWLIST } = await vendorImport<{ CODEX_EXEC_ENV_ALLOWLIST: readonly string[] }>('runs/shared/codex-exec-adapter.ts');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-provider-key');
    markPrivateEnvironment();
    expect(await childEnvironment(['OPENAI_API_KEY', ...privateNames], { allowlist: CODEX_EXEC_ENV_ALLOWLIST }))
      .toEqual({ OPENAI_API_KEY: false, ...Object.fromEntries(privateNames.map(name => [name, false])) });
  });
});
