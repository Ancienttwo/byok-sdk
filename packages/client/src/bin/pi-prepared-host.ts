import { extractPiConfigDigest, readPiHostConfig, requirePiHostBinding, verifyPiHostBinding } from '../adapters/pi/runtime-host-binding';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { PERMISSION_MODES, PermissionPolicySchema, type PermissionMode, type PermissionPolicy } from '@byok-sdk/protocol';
import {
  AgentSessionRuntime,
  createPreparedAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  runRpcMode,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
} from '@earendil-works/pi-coding-agent';
import { inputPreparationRuntimeIdentityString, type InputPreparationModelV1 } from '../input-preparation';
import { loaderEnvInjections } from '../daemon/environment';
import type { McpLaunchAttestation } from '../daemon/trusted-launch-cwd';
import {
  McpServerPool,
  parseTaskScopedMcpConfig,
  type TaskScopedMcpConfig,
} from '../adapters/pi/mcp-server-pool';
import {
  assemblePreparedPiToolSurface,
  type PreparedPiServerBinding,
} from '../adapters/pi/prepared-tools';

/**
 * The SDK-owned prepared launch entry for the pi runtime.
 *
 * `pi --mode rpc` can never consume a prepared request: only a session built by
 * `createPreparedAgentSession` carries the authorized binding, so the ordinary
 * CLI answers `prompt_prepared` with `prepared_session_unsupported`
 * (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:999`).
 * This process is that session — an in-process Node host that constructs it
 * with an explicit, complete tool closure and then runs the SAME `runRpcMode`
 * loop the CLI runs, so the adapter above it speaks one RPC protocol either
 * way.
 *
 * What it is NOT: it is not a second compiler and not a second executor. It
 * compiles nothing (the artifact arrives already compiled, over the RPC frame,
 * and the native session verifies it), and it reaches MCP servers through the
 * shared pool both Pi entries use (`../adapters/pi/mcp-server-pool.ts`).
 *
 * Every resource is explicit and empty:
 *
 * - Zero extensions, skills, prompt templates, themes and context files. The
 *   loader below is constructed and deliberately never reloaded, so no file on
 *   this device can contribute to the system prompt. That is what makes the
 *   session's own projection predictable enough for the native
 *   `prepared_context_drift` check to mean something: a preparation compiled
 *   against any other prompt shape is REFUSED rather than silently run.
 * - No native tools. See `../adapters/pi/prepared-tools.ts` for why, and for
 *   the exact native API fact that is NOT the reason.
 *
 * Failure is always closed and always before anything is sent: a malformed
 * configuration, an unresolvable runtime closure, a tool surface that no longer
 * matches what was counted, or a loader-injected environment each exit
 * non-zero with a stable reason on stderr, and no session is created at all.
 */

const CONFIG_FORMAT = 'byok.pi.prepared-launch';
const CONFIG_VERSION = 1;
const EXIT_CONFIG = 78; // EX_CONFIG

function fail(message: string): never {
  process.stderr.write(`byok-pi-prepared: ${message}\n`);
  process.exit(EXIT_CONFIG);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function requireStringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (!isPlainObject(value)) fail(`${field} must be an object`);
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') fail(`${field}.${key} must be a string`);
    record[key] = entry;
  }
  return Object.freeze(record);
}

/** The exact model identity the durable record pinned, re-validated field by field. */
function parseModel(value: unknown): InputPreparationModelV1 {
  if (!isPlainObject(value)) fail('expected.model must be an object');
  if (value.api !== 'openai-completions') fail('expected.model.api must be "openai-completions"');
  if (typeof value.reasoning !== 'boolean') fail('expected.model.reasoning must be a boolean');
  if (!Array.isArray(value.input) || value.input.some((entry) => entry !== 'text' && entry !== 'image')) {
    fail('expected.model.input must be an array of "text" | "image"');
  }
  if (!isPlainObject(value.cost)) fail('expected.model.cost must be an object');
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (typeof value.cost[key] !== 'number') fail(`expected.model.cost.${key} must be a number`);
  }
  for (const key of ['contextWindow', 'maxTokens']) {
    if (typeof value[key] !== 'number') fail(`expected.model.${key} must be a number`);
  }
  return Object.freeze({
    id: requireString(value.id, 'expected.model.id'),
    name: requireString(value.name, 'expected.model.name'),
    api: 'openai-completions',
    provider: requireString(value.provider, 'expected.model.provider'),
    baseUrl: requireString(value.baseUrl, 'expected.model.baseUrl'),
    reasoning: value.reasoning,
    input: Object.freeze([...(value.input as ('text' | 'image')[])]),
    cost: Object.freeze({
      input: value.cost.input as number,
      output: value.cost.output as number,
      cacheRead: value.cost.cacheRead as number,
      cacheWrite: value.cost.cacheWrite as number,
    }),
    contextWindow: value.contextWindow as number,
    maxTokens: value.maxTokens as number,
  });
}

function parseLaunch(value: unknown): McpLaunchAttestation {
  if (!isPlainObject(value)) fail('launch must be an object');
  const launchCwd = requireString(value.launchCwd, 'launch.launchCwd');
  if (!isAbsolute(launchCwd)) fail('launch.launchCwd must be an absolute path');
  const launcher = value.launcher;
  if (launcher !== null && !isPlainObject(launcher)) fail('launch.launcher must be an object or null');
  return Object.freeze({
    launchCwd,
    launcher: launcher === null
      ? null
      : Object.freeze({ ...launcher }) as McpLaunchAttestation['launcher'],
  });
}

/** What the pi adapter writes for exactly one prepared operation. */
interface PreparedLaunchConfig {
  readonly binding: ImplementationSpawnBindingV1;
  readonly cwd: string;
  readonly policy: PermissionPolicy;
  readonly countedPermissionMode: PermissionMode;
  readonly model: InputPreparationModelV1;
  readonly toolBindingDigest: string;
  readonly observationDigest: string;
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  readonly launch: McpLaunchAttestation;
  readonly mcp: TaskScopedMcpConfig;
}

function loadConfig(configPath: string, digest: string): PreparedLaunchConfig {
  let parsed: unknown;
  try {
    parsed = readPiHostConfig(configPath, digest);
  } catch (cause) {
    fail(`${configPath} could not be read as JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!isPlainObject(parsed)) fail('the prepared launch configuration must be an object');
  if (parsed.format !== CONFIG_FORMAT) fail(`the prepared launch configuration must declare format ${CONFIG_FORMAT}`);
  if (parsed.version !== CONFIG_VERSION) fail(`the prepared launch configuration must declare version ${CONFIG_VERSION}`);

  // Parsed with the protocol's own schema rather than by hand: this value is
  // what decides the native tool selection, and a hand-rolled reader would be a
  // second, laxer definition of a security-control shape that is `.strict()` on
  // purpose.
  const policyResult = PermissionPolicySchema.safeParse(parsed.policy);
  if (!policyResult.success) fail(`policy is not a valid permission policy: ${policyResult.error.message}`);

  const countedPermissionMode = parsed.countedPermissionMode;
  if (typeof countedPermissionMode !== 'string'
    || !(PERMISSION_MODES as readonly string[]).includes(countedPermissionMode)) {
    fail(`countedPermissionMode must be one of [${PERMISSION_MODES.join(', ')}]`);
  }
  if (!isPlainObject(parsed.expected)) fail('expected must be an object');

  const cwd = requireString(parsed.cwd, 'cwd');
  if (!isAbsolute(cwd)) fail('cwd must be an absolute path');

  const mcp = parseTaskScopedMcpConfig(parsed.mcp, fail);
  // One mode, stated once. The pool's own configuration carries it because the
  // ordinary extension reads the same shape; a disagreement between the two
  // copies would mean the registered set and the verified set were chosen under
  // different policies.
  if (mcp.permissionMode !== countedPermissionMode) {
    fail('mcp.permissionMode disagrees with countedPermissionMode');
  }

  return Object.freeze({
    binding: requirePiHostBinding(parsed.binding),
    cwd,
    policy: policyResult.data,
    countedPermissionMode: countedPermissionMode as PermissionMode,
    model: parseModel(parsed.expected.model),
    toolBindingDigest: requireString(parsed.toolBindingDigest, 'toolBindingDigest'),
    observationDigest: requireString(parsed.observationDigest, 'observationDigest'),
    toolsetDefinitionRevisions: requireStringRecord(parsed.toolsetDefinitionRevisions, 'toolsetDefinitionRevisions'),
    launch: parseLaunch(parsed.launch),
    mcp,
  });
}

/**
 * The projected servers, in the canonical order the preparation digested them
 * in: by server name, byte-wise.
 *
 * Derived from the pool's own configuration rather than carried as a second
 * list. The binding digest commits to `(serverName, toolsetId, command, args)`,
 * and every one of those already travels in the task-scoped MCP configuration —
 * a separate copy could disagree with the servers this process actually starts.
 */
function projectedServerBindings(mcp: TaskScopedMcpConfig): readonly PreparedPiServerBinding[] {
  return Object.freeze(Object.keys(mcp.observation)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((serverName) => {
      const server = mcp.mcpServers[serverName]!;
      return Object.freeze({
        serverName,
        toolsetId: mcp.observation[serverName]!.toolsetId,
        command: server.command,
        args: Object.freeze([...(server.args ?? [])]),
      });
    }));
}

function parseArgs(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config') fail('usage: byok-pi-prepared --config <path>');
  const configPath = argv[1]!;
  if (!isAbsolute(configPath)) fail('--config must be an absolute path');
  return configPath;
}

export async function runPiPreparedHost(argv: readonly string[]): Promise<void> {
  // The same assertion `bin/byok-launch-cwd.mjs` makes, for the same reason and
  // at the same kind of boundary: these take effect before this file's first
  // statement, so this process cannot sanitize them for itself — it can only
  // refuse to establish a prepared session under them.
  if (process.execArgv.length > 0) {
    fail(`refusing to launch with a non-empty interpreter argv: ${process.execArgv.join(' ')}`);
  }
  const injected = loaderEnvInjections(process.env);
  if (injected.length > 0) {
    fail(`refusing to launch with loader environment variables set: ${injected.join(', ')}`);
  }

  const owned = extractPiConfigDigest(argv, fail);
  const config = loadConfig(parseArgs(owned.args), owned.digest);

  // Derived from the VERIFIED installed artifact closure, never from the
  // configuration: a runtime identity a caller could state is a fingerprint
  // input a caller could choose.
  let runtimeIdentity: string;
  try {
    runtimeIdentity = inputPreparationRuntimeIdentityString(await verifyPiHostBinding(config.binding, 'pi-prepared', fail));
  } catch (cause) {
    fail(`the installed pi closure could not be verified: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const pool = new McpServerPool(config.mcp, fail);
  const surface = await assemblePreparedPiToolSurface({
    policy: config.policy,
    countedPermissionMode: config.countedPermissionMode,
    observation: config.mcp.observation,
    toolsetDefinitionRevisions: config.toolsetDefinitionRevisions,
    servers: projectedServerBindings(config.mcp),
    launch: config.launch,
    toolImplementations: config.mcp.toolImplementations,
    runtimeIdentity,
    expectedToolBindingDigest: config.toolBindingDigest,
    expectedObservationDigest: config.observationDigest,
    host: pool,
  });
  if (!surface.ok) {
    await pool.close();
    fail(`${surface.code}: ${surface.message}`);
  }

  // pi's OWN resolution of where its per-user state lives, run in THIS process
  // where HOME is the task's. The native factory refuses to resolve it for the
  // caller; that is a rule about the factory, not a reason to re-derive pi's
  // own directory layout in the daemon and hand a second opinion down.
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(config.cwd, agentDir);
  const sessionManager = SessionManager.create(config.cwd);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    // No catalog file and no catalog refresh: the model this session sends with
    // is the one the record pinned, handed in below. A network refresh here
    // would be an unrelated egress on a path whose whole point is that the
    // request was already decided.
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  // Constructed and never reloaded — see this file's own doc comment. Every
  // getter answers the constructor's empty state, so no extension, skill,
  // prompt template, theme or context file on this device reaches the session.
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir,
    settingsManager,
  });

  const created = await createPreparedAgentSession({
    cwd: config.cwd,
    agentDir,
    model: config.model as never,
    // The frozen request carries its own reasoning configuration inside D, so
    // this affects nothing the provider is sent; it is required, and "off" is
    // the only value that claims nothing the artifact did not already decide.
    thinkingLevel: 'off',
    modelRuntime,
    settingsManager,
    sessionManager,
    resourceLoader,
    tools: surface.tools.map((entry) => ({
      name: entry.name,
      identity: entry.identity,
      tool: entry.tool as never,
    })),
  });

  // Established here rather than left to whatever this device's settings say.
  // The native session refuses a prepared request outright while either is on
  // (`prepared_session_ineligible`), because an auto-compaction or an
  // application-level retry would write to, or re-issue, the very request that
  // was frozen. A prepared host that inherited them would be a host whose
  // admission depends on a user's settings file.
  created.session.setAutoCompactionEnabled(false);
  created.session.setAutoRetryEnabled(false);

  // No session-shutdown hook is registered for the pool: `runRpcMode` never
  // returns, and the adapter that spawned this process owns its whole tree
  // (`../adapters/pi/rpc-client.ts`'s `adoptOwnedProcessTree`), so the server
  // children are reaped with it. Closing the pool from a signal handler here
  // would install a second, racing disposal authority over the same children.

  const services: AgentSessionServices = {
    cwd: config.cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    diagnostics: [],
  };
  // The runtime host `runRpcMode` drives. Its session-replacement factory
  // refuses: `new_session`, `switch_session`, `fork` and `clone` are all
  // `PREPARED_RESERVED_COMMANDS` and are already refused by the RPC loop while a
  // reservation is held, but a prepared session must never be replaced at any
  // point in its life — the replacement would carry no authorized binding and
  // would silently become an ordinary session on the same transport.
  const runtime = new AgentSessionRuntime(
    created.session,
    services,
    async () => {
      throw new Error('a prepared pi session is never replaced; start a new prepared operation instead');
    },
  );

  await runRpcMode(runtime);
}
