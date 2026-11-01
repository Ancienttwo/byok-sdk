import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import { bindMcpToolsetServerObservation, observeMcpServer } from '../../mcp/observation';
import type { McpStdioServerConfig, McpToolsetToolObservation, MessageDraftDelta, RuntimeAdapter, RuntimeAdapterDescriptor, RuntimeDetectResult, Session } from '../../types';
import { startPreparedOperation, type PreparedOperationResources } from '../fixtures/prepared-operation';
import { runtimeVersionPolicyProjection } from '../../runtime-version-policy';
import { startEgressRecorder, type EgressAttempt, type EgressRecorder } from './loopback';

/**
 * #1103 runtime contract suite. Each adapter file binds every case below to a
 * check or to an explicit, reasoned skip; the record type makes a missing case
 * a type error, and {@link defineRuntimeContract} refuses a skip that hides a
 * capability the adapter descriptor advertises.
 */
export const CONTRACT_CASES = Object.freeze({
  'detect.version': 'detect() is available and names the expected version, with an advisory exactly when it is not the qualified one',
  'detect.auth.absent': 'detect() reports authPresent false with no credential',
  'detect.auth.apiKey': 'detect() reports authPresent true for an API key in the environment',
  'detect.auth.login': 'detect() reports authPresent true for the runtime\'s own stored login',
  'mcp.submitResult': 'a Host MCP server reaches the model and its submit_result call reaches the server',
  'instructions.project': 'the project instruction file in the workspace reaches the model (folder trust)',
  'isolation.userContext': 'with user context excluded, user-level instructions do not reach the model (positive control: they do when inherited)',
  'isolation.userMcp': 'with user MCP servers excluded, a user-configured MCP server is not started (positive control: it is when inherited)',
  'isolation.sessionPersistence': 'with session persistence disabled, no transcript is written',
  'drafts': 'streamed model text arrives as message_draft_delta events',
  'gate.auto': 'the auto gate refuses a high-risk native tool call before it executes',
  'egress.declaredHostsOnly': 'no request left for a host other than the loopback provider',
});
export type ContractCaseId = keyof typeof CONTRACT_CASES;

export interface ContractSkip { readonly skip: string }
export const skip = (reason: string): ContractSkip => ({ skip: reason });
export interface ContractCheck { readonly run: () => Promise<void>; readonly timeoutMs?: number }
export const check = (run: () => Promise<void>, timeoutMs?: number): ContractCheck => ({ run, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
export type ContractPlan = { readonly [K in ContractCaseId]: ContractCheck | ContractSkip };

export type ContractRuntime = 'pi' | 'claude' | 'codex' | 'grok' | 'hermes' | 'dsh';
export type ContractMode = 'qualified' | 'latest';

/** The run mode. The suite's own vitest config refuses to start without it, so this never defaults. */
export function contractMode(): ContractMode {
  const mode = process.env.BYOK_RUNTIME_CONTRACT;
  if (mode !== 'qualified' && mode !== 'latest') throw new Error('BYOK_RUNTIME_CONTRACT must be qualified or latest');
  return mode;
}

export interface ContractTarget {
  readonly runtime: ContractRuntime;
  readonly mode: ContractMode;
  readonly qualifiedVersion: string;
  /** The version this run installed: the qualified one, or the latest one the workflow resolved. */
  readonly expectedVersion: string;
  /** Absolute path of the installed runtime executable. */
  readonly bin: string;
}

/**
 * The installed runtime under test. A selected runtime without its
 * executable fails the run; it is never a skip.
 */
export function contractTarget(runtime: Exclude<ContractRuntime, 'pi'>, qualifiedVersion: string): ContractTarget {
  const mode = contractMode();
  const key = runtime.toUpperCase();
  const bin = process.env[`BYOK_CONTRACT_${key}_BIN`] ?? '';
  if (!path.isAbsolute(bin) || !existsSync(bin)) throw new Error(`BYOK_CONTRACT_${key}_BIN must name the installed ${runtime} executable (got ${JSON.stringify(bin)})`);
  const expectedVersion = mode === 'qualified' ? qualifiedVersion : process.env[`BYOK_CONTRACT_${key}_VERSION`] ?? '';
  if (expectedVersion === '') throw new Error(`BYOK_CONTRACT_${key}_VERSION must name the latest ${runtime} version this run installed`);
  return { runtime, mode, qualifiedVersion, expectedVersion, bin };
}

/**
 * The plan's own admission, before any case registers: every case is present,
 * a skip names a nonempty reason, and no skip hides a capability the adapter
 * descriptor advertises. Extracted so the fail-closed rules are testable
 * without a real runtime CLI.
 */
export function assertContractPlan(descriptor: RuntimeAdapterDescriptor, plan: ContractPlan): void {
  const capabilities = descriptor.capabilities;
  const advertised: Partial<Record<ContractCaseId, boolean>> = {
    'mcp.submitResult': capabilities.mcpToolsets === true,
    drafts: capabilities.messageDraft === true,
    'gate.auto': capabilities.toolAuthorizationAuto === true,
    'isolation.userContext': capabilities.isolation?.userContext === true,
    'isolation.userMcp': capabilities.isolation?.userMcpServers === true,
    'isolation.sessionPersistence': capabilities.isolation?.sessionPersistence === true,
  };
  for (const id of Object.keys(CONTRACT_CASES) as ContractCaseId[]) {
    if (!(id in plan)) throw new Error(`${descriptor.id}: contract plan is missing the ${id} case`);
  }
  for (const [id, entry] of Object.entries(plan) as Array<[ContractCaseId, ContractCheck | ContractSkip]>) {
    if ('skip' in entry && advertised[id] === true) throw new Error(`${descriptor.id}: ${id} is advertised by the descriptor and cannot be skipped`);
    if ('skip' in entry && entry.skip.trim() === '') throw new Error(`${descriptor.id}: ${id} skip needs a reason`);
  }
}

/** Register every case for one adapter. */
export function defineRuntimeContract(title: string, descriptor: RuntimeAdapterDescriptor, plan: ContractPlan): void {
  assertContractPlan(descriptor, plan);
  describe(title, () => {
    for (const id of Object.keys(CONTRACT_CASES) as ContractCaseId[]) {
      const entry = plan[id];
      if ('skip' in entry) it.skip(`${id}: skipped: ${entry.skip}`, () => {});
      else it(`${id}: ${CONTRACT_CASES[id]}`, entry.run, entry.timeoutMs ?? 180_000);
    }
  });
}

/** Register every case as skipped for one reason that covers the whole runtime in this mode. */
export function skipRuntimeContract(title: string, reason: string): void {
  describe(title, () => {
    for (const id of Object.keys(CONTRACT_CASES) as ContractCaseId[]) it.skip(`${id}: skipped: ${reason}`, () => {});
  });
}

/** The skip reason for a capability the descriptor does not advertise. */
export function notAdvertised(descriptor: RuntimeAdapterDescriptor, capability: string): ContractSkip {
  return skip(`${descriptor.id} descriptor does not advertise ${capability}`);
}

/** Run `fn` with `env` as the whole process environment; detect() reads it. */
export async function withProcessEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** The ambient variables a child needs to start at all; nothing user-specific. */
export function baseEnv(home: string): NodeJS.ProcessEnv {
  const keep = ['PATH', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG'];
  return {
    ...Object.fromEntries(keep.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
  };
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
}

/** A fresh HOME and workspace; removed after the file. */
export async function createSandbox(label: string): Promise<Sandbox> {
  // On macOS, Codex 0.160's file watcher stalls thread/start for a home
  // under /private/tmp, where the shared vitest temp root lives; the config
  // records the user's own temp directory before that root replaces TMPDIR.
  const parent = process.platform === 'darwin' ? process.env.BYOK_RUNTIME_CONTRACT_TMP ?? os.tmpdir() : os.tmpdir();
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, `rc-${label}-`)));
  roots.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  return { root, home, workspace };
}

let egress: Promise<EgressRecorder> | undefined;
/** One recorder per file; every detect and turn of the file runs behind it. */
export function fileEgress(): Promise<EgressRecorder> {
  egress ??= startEgressRecorder();
  return egress;
}
afterAll(async () => { await (await egress)?.close(); });

/** A host a runtime is known to contact on its own, in one phase, with the reason it is declared. */
export interface DeclaredHost { readonly phase: EgressAttempt['phase']; readonly target: string; readonly reason: string }

/**
 * The egress case: it runs last in the file, after every runtime process of
 * the file. Every proxied attempt must match a declared host of its phase;
 * the loopback provider is reached directly and never proxied.
 */
export function egressCheck(prerequisites: () => Promise<unknown>, declaredHosts: readonly DeclaredHost[] = []): ContractCheck {
  return check(async () => {
    await prerequisites();
    const recorder = await fileEgress();
    const declared = (attempt: EgressAttempt) => declaredHosts.some(host => host.phase === attempt.phase && host.target === attempt.target);
    expect(recorder.attempts.filter(attempt => !declared(attempt))).toEqual([]);
  });
}

/** detect() with exactly `env` as the process environment, behind the egress recorder. */
export async function detectWith(adapter: Pick<RuntimeAdapter, 'detect'>, env: NodeJS.ProcessEnv): Promise<RuntimeDetectResult> {
  const recorder = await fileEgress();
  recorder.phase = 'detect';
  try {
    return await withProcessEnv({ ...env, ...recorder.env }, () => adapter.detect());
  } finally {
    recorder.phase = 'turn';
  }
}

/**
 * The version case. `identifies` is this file's own reading of the version
 * text, independent of the adapter's parser, so a broken adapter parser fails
 * here. `advisory` says whether the adapter has an unqualified-version
 * advisory at all.
 */
export function expectDetectedVersion(
  result: RuntimeDetectResult,
  target: Pick<ContractTarget, 'expectedVersion' | 'qualifiedVersion'>,
  identifies: (version: string, expected: string) => boolean,
  advisory: boolean,
): void {
  if (result.kind !== 'available') expect.fail(`detect(): ${JSON.stringify(result)}`);
  expect(typeof result.version).toBe('string');
  expect(identifies(result.version!, target.expectedVersion), `detected ${JSON.stringify(result.version)}, expected ${target.expectedVersion}`).toBe(true);
  const qualified = identifies(result.version!, target.qualifiedVersion);
  // #1103: every bundled adapter reports the effective policy verdict. A
  // qualified token is an allow; an unqualified one is a warn exactly where the
  // adapter has the legacy advisory (Codex/Grok/Hermes), and an allow for
  // Claude/Pi whose default policy admits everything. A Host block never
  // applies to these fixture adapters.
  expect(result.versionVerdict, 'detect() must report the effective version policy verdict').toBeDefined();
  expect(result.versionVerdict?.qualifiedVersion).toBe(target.qualifiedVersion);
  const state = qualified || !advisory ? 'allow' : 'warn';
  expect(result.versionVerdict?.state).toBe(state);
  // #1103 B2b: the hello/presence projection is the same verdict, reduced to
  // state + qualified token. A regression that invents allow, drops the
  // projectable field or carries a local `matched` spec fails here for every
  // bundled adapter.
  expect(runtimeVersionPolicyProjection(result.versionVerdict)).toEqual({ state, qualifiedVersion: target.qualifiedVersion });
  if (advisory && !qualified) expect(result.advisory).toEqual({ reason: 'runtime_version_unqualified', qualifiedVersion: target.qualifiedVersion });
  else expect(result.advisory).toBeUndefined();
}

export function expectAuth(result: RuntimeDetectResult, authPresent: boolean): void {
  if (result.kind !== 'available') expect.fail(`detect(): ${JSON.stringify(result)}`);
  expect(result.authPresent).toBe(authPresent);
}

/** The Host MCP server of the contract turn: one `submit_result` tool, each call appended to `receipt`. */
export async function writeSubmitResultServer(dir: string, receipt: string, tool = 'submit_result'): Promise<McpStdioServerConfig> {
  const file = path.join(dir, `${tool}-server.mjs`);
  await fs.writeFile(file, `import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(`${receipt}.spawn`)}, process.pid + '\\n');
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame.id === undefined) return;
  let result;
  if (frame.method === 'initialize') result = { protocolVersion: frame.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'runtime-contract', version: '1.0.0' } };
  else if (frame.method === 'tools/list') result = { tools: [{ name: ${JSON.stringify(tool)}, description: 'Record the runtime contract result', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } }] };
  else if (frame.method === 'tools/call') { appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(frame.params) + '\\n'); result = { content: [{ type: 'text', text: 'runtime contract result accepted' }] }; }
  else if (frame.method === 'ping') result = {};
  else { send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'method not found' } }); return; }
  send({ jsonrpc: '2.0', id: frame.id, result });
});
`);
  return { command: process.execPath, args: [file] };
}

/** Lines of a JSONL receipt; an absent file is no lines. */
export async function readReceipt(file: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Whether a server written by {@link writeSubmitResultServer} was ever started. */
export function spawned(receipt: string): boolean {
  return existsSync(`${receipt}.spawn`);
}

/** The daemon's `tools/list` observation of each server, for adapters that require one. */
export async function observeServers(servers: Readonly<Record<string, McpStdioServerConfig>>, env: NodeJS.ProcessEnv): Promise<McpToolsetToolObservation> {
  const entries = await Promise.all(Object.entries(servers).map(async ([name, server]) => {
    const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const observation = await observeMcpServer(name, { command: server.command, args: [...(server.args ?? [])] }, { env: childEnv, timeoutMs: 15_000 });
    return [name, bindMcpToolsetServerObservation(observation, `contract.${name}`)] as const;
  }));
  return Object.fromEntries(entries);
}

export type TurnEvent = AgentEvent | MessageDraftDelta;

/** Start one prepared operation and read it to `turn_end`. */
export async function runTurn(
  adapter: RuntimeAdapter,
  instruction: string,
  resources: PreparedOperationResources,
  timeoutMs = 120_000,
): Promise<TurnEvent[]> {
  const session: Session = await startPreparedOperation(adapter, { instruction }, resources);
  const events: TurnEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        for await (const event of session.events) {
          events.push(event);
          if (event.type === 'turn_end') return;
        }
        throw new Error(`session ended without turn_end: ${JSON.stringify(events.slice(-5))}`);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`turn exceeded ${timeoutMs} ms: ${JSON.stringify(events.slice(-5))}`)), timeoutMs); }),
    ]);
    return events;
  } finally {
    clearTimeout(timer);
    await session.close();
  }
}

/**
 * The text the daemon feeds the Agent message draft: `message_draft_delta`
 * events, and `progress` deltas from an adapter whose progress events are
 * streaming deltas rather than whole messages (`event-pump.ts`).
 */
export function draftText(events: readonly TurnEvent[], descriptor: RuntimeAdapterDescriptor): string {
  return events.flatMap(event => event.type === 'message_draft_delta' ? [event.text]
    : event.type === 'progress' && descriptor.progressEventsAreMessages !== true ? [event.text] : []).join('');
}

/** Memoize one expensive turn shared by several cases. */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= fn());
}
