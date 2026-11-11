import { OpenCodeAdapter, type OpenCodeAdapterOptions } from './opencode/opencode-adapter';
import type { RuntimeId } from '@byok-sdk/protocol';
import { isAbsolute } from 'node:path';
import type { RuntimeAdapter, RuntimeVersionPolicy } from '../types';
import { assertRuntimeEnvironmentPolicy, type RuntimeEnvironmentPolicy } from '../runtime/environment';
import type { SdkHelperHostConfig } from '../sdk-reserved-helper-host';
import { foldNameAliases } from '../util/fold-name-aliases';
import { DaemonConfigInvalidError } from '../daemon-config-invalid-error';
import type { DaemonConfigIssue } from '../daemon/config-schema/validate';
import { versionPolicyConfigIssues } from '../daemon-config-version-policy';
import { PiAdapter, PI_PACKAGE_DIR_ENV, validatePiByokLauncherConfig, type PiAdapterOptions, type PiByokLauncherConfig } from './pi/pi-adapter';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './claude/claude-adapter';
import { CodexAdapter, assertCodexSandboxSetting, type CodexAdapterOptions, type CodexSandboxSetting } from './codex/codex-adapter';
import { GrokAdapter, type GrokAdapterOptions } from './grok/grok-adapter';
import { DshAdapter, type DshAdapterOptions } from './dsh/dsh-adapter';
import { AgyAdapter, type AgyAdapterOptions } from './antigravity/agy-adapter';

/** `RuntimeAdaptersConfig.runtimes.pi`: the Pi options a Host can configure. */
export interface PiRuntimeConfig {
  /** `PiAdapterOptions.agentUserContext`: `excluded` keeps user Pi resources and settings out of an Agent task (model and auth stores stay). Default `inherit`. */
  agentUserContext?: PiAdapterOptions['agentUserContext'];
  /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
  versionPolicy?: RuntimeVersionPolicy;
  /** This runtime's environment policy (#1759): it replaces the top-level `runtimeEnvironment` for this runtime; it is not merged with the top-level `pass`. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /**
   * `PiAdapterOptions.packageDir`: the absolute Pi asset root of a product
   * that bundles Pi. It is the only source: the SDK sets it as
   * `PI_PACKAGE_DIR` for Pi and the pi-host helper process alone, and
   * removes any `PI_PACKAGE_DIR` the login shell or Host environment holds.
   */
  packageDir?: string;
}

/**
 * Isolation options of the SDK-built runtime adapters (#1094), passed to each
 * adapter's constructor; an unset option keeps the adapter's default, under
 * which a runtime keeps the user's own context, sessions and MCP servers.
 * Which runtimes are built stays `runtimeAllowlist`, and the Codex sandbox
 * stays `codexSandbox`.
 */
export interface RuntimeAdaptersRuntimes {
  pi?: PiRuntimeConfig;
  claude?: {
    /** `ClaudeAdapterOptions.agentUserContext`: `excluded` keeps user MCP servers, `CLAUDE.md` files, rules and auto memory out of an Agent task. Default `inherit`. */
    agentUserContext?: ClaudeAdapterOptions['agentUserContext'];
    /** `ClaudeAdapterOptions.agentSessionPersistence`: `disabled` does not save an Agent task's session transcript, so it cannot be resumed. Default `enabled`. */
    agentSessionPersistence?: ClaudeAdapterOptions['agentSessionPersistence'];
    /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** This runtime's environment policy (#1759): it replaces the top-level `runtimeEnvironment` for this runtime; it is not merged with the top-level `pass`. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
  };
  codex?: {
    /** `CodexAdapterOptions.agentUserMcpServers`: `excluded` disables the user's MCP servers and plugins for an Agent task. Default `inherit`. */
    agentUserMcpServers?: CodexAdapterOptions['agentUserMcpServers'];
    /** `CodexAdapterOptions.agentUserContext`: `excluded` runs an Agent task in an SDK-owned `CODEX_HOME` that keeps the user's `AGENTS.md`, skills, memories and threads out, links the login, configuration and guardrails, and keeps the Agent's threads in its home. Default `inherit`. */
    agentUserContext?: CodexAdapterOptions['agentUserContext'];
    /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** This runtime's environment policy (#1759): it replaces the top-level `runtimeEnvironment` for this runtime; it is not merged with the top-level `pass`. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
  };
  /** Applies only when `runtimeAllowlist` lists `grok`. */
  grok?: {
    /** `GrokAdapterOptions.compatInstructions`: `disabled` turns off Grok's Claude and Cursor instruction and rules compatibility scanning. Default `inherit`. */
    compatInstructions?: GrokAdapterOptions['compatInstructions'];
    /** `GrokAdapterOptions.agentUserMcpServers`: `excluded` switches off the user MCP sources Grok can disable and refuses an Agent task while another is enabled. Default `inherit`. */
    agentUserMcpServers?: GrokAdapterOptions['agentUserMcpServers'];
    /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** This runtime's environment policy (#1759): it replaces the top-level `runtimeEnvironment` for this runtime; it is not merged with the top-level `pass`. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
  };
  /** Required when `runtimeAllowlist` lists `dsh`, and applies only then. dsh has no default model and runs on darwin and linux only. */
  dsh?: {
    /** `DshAdapterOptions.home`: the absolute `DSH_HOME` the SDK owns. It must persist across executions, because dsh keeps its sessions there, and must not be `~/.dsh`. */
    home: DshAdapterOptions['home'];
    /** `DshAdapterOptions.model`: provider, model, `baseUrl` and the name of the variable that holds the key. */
    model: DshAdapterOptions['model'];
    /** `DshAdapterOptions.sandbox`: dsh's sandbox for every session. Default `danger-full-access`. */
    sandbox?: DshAdapterOptions['sandbox'];
    /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** This runtime's environment policy (#1759): it replaces the top-level `runtimeEnvironment` for this runtime; it is not merged with the top-level `pass`. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
  };
  /** Required when runtimeAllowlist lists opencode. Native user configuration is inherited. */
  opencode?: {
    models: OpenCodeAdapterOptions['models'];
    /** Absolute executable override, resolved before PATH. Never installs or migrates OpenCode. */
    executable?: string;
    versionPolicy?: RuntimeVersionPolicy;
    /** This runtime's environment policy (#1759): it replaces the top-level `runtimeEnvironment` for this runtime; it is not merged with the top-level `pass`. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
  };
  /** Required when `runtimeAllowlist` lists `agy`, and applies only then. */
  agy?: {
    /** `AgyAdapterOptions.home`: the absolute OS home the SDK owns for agy and its tools. It must persist across executions and must not be the user's home. */
    home: AgyAdapterOptions['home'];
    /** `AgyAdapterOptions.model`: the model id of every session. Default: the CLI's own. */
    model?: AgyAdapterOptions['model'];
    /** A complete version policy that replaces the adapter default wholesale; `block` is allowed here because it is Host configuration (#1103). */
    versionPolicy?: RuntimeVersionPolicy;
    /** This runtime's environment policy (#1759): it replaces the top-level `runtimeEnvironment` for this runtime; it is not merged with the top-level `pass`. */
    runtimeEnvironment?: RuntimeEnvironmentPolicy;
  };
}

/**
 * The input of {@link createRuntimeAdapters}: the `DaemonConfig` keys that
 * configure the SDK-built adapters, with the same meaning. The durable Pi
 * lane (`DaemonConfig.runtimes.pi.durableLane`) needs the daemon's journal,
 * so only the daemon builds it.
 */
export interface RuntimeAdaptersConfig {
  /** Absolute native asset root of every built adapter. */
  nativeAssetRoot?: string;
  /** Re-enter the product's single-file/SEA executable for SDK helpers and every Pi launch. */
  sdkHelperHost?: SdkHelperHostConfig;
  /** Runtimes to build: unset = pi, claude and codex; set = exactly the listed ids (unknown ids ignored). `grok`, `dsh` and `agy` are built only when listed. */
  runtimeAllowlist?: string[];
  runtimes?: RuntimeAdaptersRuntimes;
  /** The environment a built runtime gives its children (#1095) when `runtimes.<id>.runtimeEnvironment` is unset; Pi's policy must not pass `PI_PACKAGE_DIR`. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** Separate-process Pi BYOK credential boundary. */
  piByokLauncher?: PiByokLauncherConfig;
  /** Codex sandbox of the built Codex adapter. Default `danger-full-access`. */
  codexSandbox?: CodexSandboxSetting;
}

/** `DaemonConfig.runtimes.pi`: the factory's Pi options and the durable lane. */
export interface DaemonPiRuntimeConfig extends PiRuntimeConfig {
  /** `PiAdapterOptions.durableLane`: the opt-in durable worker. Disabled by default. Requires `agentHome` and `piByokLauncher`; unavailable on Windows. */
  durableLane?: PiAdapterOptions['durableLane'];
}

/** `DaemonConfig.runtimes`: {@link RuntimeAdaptersRuntimes} with the durable Pi lane. */
export interface DaemonRuntimesConfig extends RuntimeAdaptersRuntimes {
  pi?: DaemonPiRuntimeConfig;
}

/** The daemon's form of {@link RuntimeAdaptersConfig}: it also admits the durable Pi lane. */
export interface DaemonRuntimeAdaptersConfig extends RuntimeAdaptersConfig {
  runtimes?: DaemonRuntimesConfig;
}

/**
 * Canonical construction/identity order for `createDaemon`'s bundled adapter
 * set (`buildRuntimeAdapters` below) and for `conn.hello.runtimes`
 * reporting order (`detectRuntimes`) — this is NOT the auto-select priority
 * order.
 *
 * M5 batch-3 (workstream 1): auto-select priority now lives entirely in
 * `task-runner.ts`, as its own explicit order independent of this one — see
 * `DEFAULT_RUNTIME_PREFERENCE`/`TaskRunner.pickAdapter`, overridable
 * per-daemon via `DaemonConfig.runtimePreference` above. Before this change,
 * `pickAdapter`'s no-runtime branch walked `deps.adapters` directly (this
 * array's own construction order), so listing pi first here silently made
 * it the de-facto DEFAULT auto-selected runtime whenever present — the
 * opposite of the product decision that pi is the FALLBACK runtime (tried
 * only once nothing better is available/capable), not the default. That
 * conflation is why this constant's order and the auto-select order are now
 * two independent things: this one stays `['pi', 'claude', 'codex']`
 * (unchanged — still a perfectly fine construction/reporting order, and
 * changing it would needlessly reshuffle `conn.hello.runtimes` for no
 * reason), while `DEFAULT_RUNTIME_PREFERENCE` states the actual selection
 * priority explicitly (`['claude', 'codex', 'pi']`, pi last) instead of
 * leaving it as an implicit side effect of this list's order.
 */
export const ALL_RUNTIME_IDS: readonly RuntimeId[] = ['pi', 'claude', 'codex'];

type SdkBuiltRuntimeId = keyof RuntimeAdaptersRuntimes;

/** The enumerated runtime options and their admitted values. */
const RUNTIME_OPTION_VALUES: Readonly<Record<keyof RuntimeAdaptersRuntimes, Readonly<Record<string, readonly string[]>>>> = {
  pi: { agentUserContext: ['excluded', 'inherit'] },
  claude: { agentUserContext: ['excluded', 'inherit'], agentSessionPersistence: ['disabled', 'enabled'] },
  codex: { agentUserMcpServers: ['excluded', 'inherit'], agentUserContext: ['excluded', 'inherit'] },
  grok: { compatInstructions: ['disabled', 'inherit'], agentUserMcpServers: ['excluded', 'inherit'] },
  dsh: { sandbox: ['danger-full-access', 'read-only', 'workspace-write'] },
  agy: {},
  opencode: {},
};

/**
 * Every runtime the SDK can build, in construction order. `grok`, `dsh` and
 * `agy` are custom harnesses, not wire runtime ids, so each is built only when
 * `runtimeAllowlist` lists it; an unset allowlist keeps `ALL_RUNTIME_IDS`.
 */
const SDK_BUILT_RUNTIME_IDS = Object.keys(RUNTIME_OPTION_VALUES) as SdkBuiltRuntimeId[];

/**
 * Builds the adapters `createDaemon` builds for the same configuration, for a
 * Host that decorates them and passes them to `createDaemonWithAdapters`.
 *
 * Throws a `TypeError` for an invalid `codexSandbox` or `runtimeEnvironment`,
 * and `DaemonConfigInvalidError` for any other invalid value, including
 * `runtimes.pi.durableLane`.
 */
export function createRuntimeAdapters(config: RuntimeAdaptersConfig): RuntimeAdapter[] {
  if (config.codexSandbox !== undefined) assertCodexSandboxSetting(config.codexSandbox, 'DaemonConfig.codexSandbox');
  assertRuntimeEnvironmentPolicies(config);
  const issues = runtimeAdaptersConfigIssues(config);
  if (issues.length > 0) throw new DaemonConfigInvalidError(issues);
  return buildRuntimeAdapters(config, resolvePiByokLauncher(config));
}

/**
 * The adapter set of a validated `DaemonConfig`: `createDaemon`, config check,
 * `byok-agent runtimes` and doctor build through it, and
 * {@link createRuntimeAdapters} after its own validation.
 */
export function buildRuntimeAdapters(config: DaemonRuntimeAdaptersConfig, piByokLauncher: PiByokLauncherConfig | undefined): RuntimeAdapter[] {
  const issues = piPackageDirIssues(config);
  if (issues.length > 0) throw new DaemonConfigInvalidError(issues);
  const ids = config.runtimeAllowlist
    ? SDK_BUILT_RUNTIME_IDS.filter((id) => config.runtimeAllowlist?.includes(id))
    : ALL_RUNTIME_IDS;
  return ids.map((id) => buildAdapter(id, config, piByokLauncher));
}

/** Each configured policy with its config path: the top-level `runtimeEnvironment`, then every `runtimes.<id>.runtimeEnvironment`. */
function configuredRuntimeEnvironments(config: Pick<RuntimeAdaptersConfig, 'runtimes' | 'runtimeEnvironment'>): Array<[path: string, value: unknown]> {
  return [['runtimeEnvironment', config.runtimeEnvironment],
    ...SDK_BUILT_RUNTIME_IDS.map((id): [string, unknown] => [`runtimes.${id}.runtimeEnvironment`, config.runtimes?.[id]?.runtimeEnvironment])];
}

/**
 * The one validation of every configured environment policy: the top-level
 * `runtimeEnvironment` and each `runtimes.<id>.runtimeEnvironment`, as config
 * issues at their own paths. `checkDaemonConfig` reports them, and
 * {@link assertRuntimeEnvironmentPolicies} throws the first.
 *
 * @internal
 */
export function runtimeEnvironmentPolicyIssues(config: Pick<RuntimeAdaptersConfig, 'runtimes' | 'runtimeEnvironment'>): DaemonConfigIssue[] {
  const issues: DaemonConfigIssue[] = [];
  for (const [path, value] of configuredRuntimeEnvironments(config)) {
    try {
      assertRuntimeEnvironmentPolicy(value, `DaemonConfig.${path}`);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      issues.push(invalid(path, error.message));
    }
  }
  return issues;
}

/**
 * {@link runtimeEnvironmentPolicyIssues} for `createDaemon` and
 * `createRuntimeAdapters`: throws a `TypeError` with the first issue's
 * message, the message `assertRuntimeEnvironmentPolicy` threw.
 *
 * @internal
 */
export function assertRuntimeEnvironmentPolicies(config: Pick<RuntimeAdaptersConfig, 'runtimes' | 'runtimeEnvironment'>): void {
  const [issue] = runtimeEnvironmentPolicyIssues(config);
  if (issue !== undefined) throw new TypeError(issue.message);
}

/**
 * The one environment policy of an SDK-built runtime (#1759):
 * `runtimes.<id>.runtimeEnvironment` replaces the top-level policy wholesale,
 * like `versionPolicy` (ADR-044); the two are never merged.
 *
 * @internal
 */
export function runtimeEnvironmentFor(id: string, config: Pick<RuntimeAdaptersConfig, 'runtimes' | 'runtimeEnvironment'>): RuntimeEnvironmentPolicy | undefined {
  return config.runtimes?.[id as SdkBuiltRuntimeId]?.runtimeEnvironment ?? config.runtimeEnvironment;
}

/** Validates `piByokLauncher` and folds its `sessionDir`; the daemon and its retention build Pi from this one value. */
export function resolvePiByokLauncher(config: Pick<RuntimeAdaptersConfig, 'piByokLauncher'>): PiByokLauncherConfig | undefined {
  validatePiByokLauncherConfig(config.piByokLauncher);
  // The launcher writes sessions here and retention sweeps it; both use this spelling.
  return config.piByokLauncher === undefined ? undefined
    : Object.freeze({ ...config.piByokLauncher, sessionDir: foldNameAliases(config.piByokLauncher.sessionDir) });
}

function buildAdapter(id: SdkBuiltRuntimeId, config: DaemonRuntimeAdaptersConfig, piByokLauncher: PiByokLauncherConfig | undefined): RuntimeAdapter {
  const policy = runtimeEnvironmentFor(id, config);
  const environment = policy === undefined ? {} : { runtimeEnvironment: policy };
  // An unset option keeps the adapter default.
  const pi = config.runtimes?.pi;
  const claude = config.runtimes?.claude;
  const codex = config.runtimes?.codex;
  const grok = config.runtimes?.grok;
  switch (id) {
    case 'pi':
      return new PiAdapter({
        nativeAssetRoot: config.nativeAssetRoot, byokLauncher: piByokLauncher, ...environment,
        ...(config.sdkHelperHost === undefined ? {} : { sdkHelperHost: config.sdkHelperHost }),
        ...(pi?.durableLane === true ? { durableLane: true } : {}),
        ...(pi?.agentUserContext === undefined ? {} : { agentUserContext: pi.agentUserContext }),
        ...(pi?.packageDir === undefined ? {} : { packageDir: pi.packageDir }),
        ...(pi?.versionPolicy === undefined ? {} : { versionPolicy: pi.versionPolicy }),
      });
    case 'claude':
      return new ClaudeAdapter({
        nativeAssetRoot: config.nativeAssetRoot, ...environment,
        ...(claude?.agentUserContext === undefined ? {} : { agentUserContext: claude.agentUserContext }),
        ...(claude?.agentSessionPersistence === undefined ? {} : { agentSessionPersistence: claude.agentSessionPersistence }),
        ...(claude?.versionPolicy === undefined ? {} : { versionPolicy: claude.versionPolicy }),
      });
    case 'codex':
      return new CodexAdapter({
        nativeAssetRoot: config.nativeAssetRoot, ...environment,
        ...(config.codexSandbox === undefined ? {} : { sandbox: config.codexSandbox }),
        ...(codex?.agentUserMcpServers === undefined ? {} : { agentUserMcpServers: codex.agentUserMcpServers }),
        ...(codex?.agentUserContext === undefined ? {} : { agentUserContext: codex.agentUserContext }),
        ...(codex?.versionPolicy === undefined ? {} : { versionPolicy: codex.versionPolicy }),
      });
    case 'grok':
      return new GrokAdapter({
        nativeAssetRoot: config.nativeAssetRoot, ...environment,
        ...(grok?.compatInstructions === undefined ? {} : { compatInstructions: grok.compatInstructions }),
        ...(grok?.agentUserMcpServers === undefined ? {} : { agentUserMcpServers: grok.agentUserMcpServers }),
        ...(grok?.versionPolicy === undefined ? {} : { versionPolicy: grok.versionPolicy }),
      });
    case 'dsh':
      return buildDshAdapter(config, environment);
    case 'agy':
      return buildAgyAdapter(config, environment);
    case 'opencode': {
      const options = config.runtimes?.opencode;
      if (!options) throw new DaemonConfigInvalidError([invalid('runtimes.opencode', 'OpenCode requires a Host model candidate list')]);
      try {
        return new OpenCodeAdapter({ models: options.models, nativeAssetRoot: config.nativeAssetRoot, ...environment,
          ...(options.executable === undefined ? {} : { resolveBin: () => ({ command: options.executable!, source: 'env' as const }) }),
          ...(options.versionPolicy === undefined ? {} : { versionPolicy: options.versionPolicy }),
        });
      } catch (error) {
        if (error instanceof TypeError) throw new DaemonConfigInvalidError([invalid('runtimes.opencode', error.message)]);
        throw error;
      }
    }
  }
}

/**
 * The `DshAdapter` constructor is the one authority on `home`, `model` and
 * `sandbox`; the daemon reports what it refuses as a config issue.
 */
function buildDshAdapter(config: DaemonRuntimeAdaptersConfig, environment: Pick<DshAdapterOptions, 'runtimeEnvironment'>): DshAdapter {
  const dsh = config.runtimes?.dsh;
  if (dsh === undefined) {
    throw new DaemonConfigInvalidError([{ severity: 'error', code: 'missing_required', path: 'runtimes.dsh', message: 'DaemonConfig.runtimes.dsh is required when runtimeAllowlist lists dsh' }]);
  }
  try {
    return new DshAdapter({
      home: dsh.home, model: dsh.model, nativeAssetRoot: config.nativeAssetRoot, ...environment,
      ...(dsh.sandbox === undefined ? {} : { sandbox: dsh.sandbox }),
      ...(dsh.versionPolicy === undefined ? {} : { versionPolicy: dsh.versionPolicy }),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new DaemonConfigInvalidError([invalid('runtimes.dsh', `DaemonConfig.runtimes.dsh is invalid: ${error.message}`)]);
    throw error;
  }
}

/** The `AgyAdapter` constructor is the one authority on `home` and `model`. */
function buildAgyAdapter(config: DaemonRuntimeAdaptersConfig, environment: Pick<AgyAdapterOptions, 'runtimeEnvironment'>): AgyAdapter {
  const agy = config.runtimes?.agy;
  if (agy === undefined) {
    throw new DaemonConfigInvalidError([{ severity: 'error', code: 'missing_required', path: 'runtimes.agy', message: 'DaemonConfig.runtimes.agy is required when runtimeAllowlist lists agy' }]);
  }
  try {
    return new AgyAdapter({
      home: agy.home, nativeAssetRoot: config.nativeAssetRoot, ...environment,
      ...(agy.model === undefined ? {} : { model: agy.model }),
      ...(agy.versionPolicy === undefined ? {} : { versionPolicy: agy.versionPolicy }),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new DaemonConfigInvalidError([invalid('runtimes.agy', `DaemonConfig.runtimes.agy is invalid: ${error.message}`)]);
    throw error;
  }
}

/** `runtimes.pi.packageDir` is the one Pi asset root: absolute, and never also passed by Pi's effective environment policy. */
function piPackageDirIssues(config: DaemonRuntimeAdaptersConfig): DaemonConfigIssue[] {
  const issues: DaemonConfigIssue[] = [];
  const packageDir = config.runtimes?.pi?.packageDir;
  if (packageDir !== undefined && !(typeof packageDir === 'string' && isAbsolute(packageDir))) {
    issues.push(invalid('runtimes.pi.packageDir', 'DaemonConfig.runtimes.pi.packageDir must be an absolute path'));
  }
  const path = config.runtimes?.pi?.runtimeEnvironment === undefined ? 'runtimeEnvironment.pass' : 'runtimes.pi.runtimeEnvironment.pass';
  if (runtimeEnvironmentFor('pi', config)?.pass?.some((name) => name.toUpperCase() === PI_PACKAGE_DIR_ENV) === true) {
    issues.push(invalid(path, `DaemonConfig.${path} must not name ${PI_PACKAGE_DIR_ENV}; set runtimes.pi.packageDir, the only source of the Pi asset root`));
  }
  return issues;
}

/** The JSON types and literals of the factory keys, which `createDaemon` checks with the DaemonConfig schema. */
function runtimeAdaptersConfigIssues(config: RuntimeAdaptersConfig): DaemonConfigIssue[] {
  const issues: DaemonConfigIssue[] = [];
  const expect = (ok: boolean, path: string, expected: string): void => {
    if (!ok) issues.push(invalid(path, `DaemonConfig.${path} must be ${expected}`));
  };
  const optional = (value: unknown, ok: (value: unknown) => boolean): boolean => value === undefined || ok(value);
  expect(optional(config.nativeAssetRoot, isString), 'nativeAssetRoot', 'a string');
  expect(optional(config.runtimeAllowlist, isStringArray), 'runtimeAllowlist', 'an array of strings');
  const host: unknown = config.sdkHelperHost;
  expect(optional(host, (value) => isObject(value) && value.mode === 'self-executable'
    && optional(value.executable, isString) && optional(value.entry, isString)), 'sdkHelperHost', 'an object with mode "self-executable" and string executable and entry');
  const launcher: unknown = config.piByokLauncher;
  expect(optional(launcher, (value) => isObject(value) && isString(value.command) && isString(value.profileDbPath) && isString(value.sessionDir)
    && optional(value.args, isStringArray) && optional(value.macosKeychainPath, isString) && optional(value.secretServicePrefix, isString)),
  'piByokLauncher', 'an object with string command, profileDbPath and sessionDir');
  const runtimes: unknown = config.runtimes;
  if (!optional(runtimes, isObject)) {
    expect(false, 'runtimes', 'an object');
  } else if (runtimes !== undefined) {
    const record = runtimes as Record<string, unknown>;
    for (const [id, options] of Object.entries(RUNTIME_OPTION_VALUES)) {
      const runtime = record[id];
      if (!optional(runtime, isObject)) {
        expect(false, `runtimes.${id}`, 'an object');
        continue;
      }
      for (const [option, values] of Object.entries(options)) {
        const value = (runtime as Record<string, unknown> | undefined)?.[option];
        expect(optional(value, (candidate) => values.includes(candidate as string)), `runtimes.${id}.${option}`, `one of ${values.map((name) => JSON.stringify(name)).join(', ')}`);
      }
    }
    const dsh = record.dsh;
    if (isObject(dsh)) {
      expect(isString(dsh.home), 'runtimes.dsh.home', 'a string');
      expect(isObject(dsh.model), 'runtimes.dsh.model', 'an object');
    }
    const opencode = record.opencode;
    if (isObject(opencode)) {
      expect(isStringArray(opencode.models), 'runtimes.opencode.models', 'an array of strings');
      expect(optional(opencode.executable, isString), 'runtimes.opencode.executable', 'a string');
    }
    const agy = record.agy;
    if (isObject(agy)) {
      expect(isString(agy.home), 'runtimes.agy.home', 'a string');
      expect(optional(agy.model, isString), 'runtimes.agy.model', 'a string');
    }
    const pi = record.pi as Record<string, unknown> | undefined;
    if (isObject(pi) && Object.hasOwn(pi, 'durableLane')) {
      issues.push(invalid('runtimes.pi.durableLane', 'DaemonConfig.runtimes.pi.durableLane needs the daemon journal, so only the SDK daemon builds the durable Pi lane; createRuntimeAdapters does not accept it'));
    }
    issues.push(...versionPolicyConfigIssues(config));
  }
  issues.push(...piPackageDirIssues(config));
  return issues;
}

function invalid(path: string, message: string): DaemonConfigIssue {
  return { severity: 'error', code: 'invalid_value', path, message };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
