import { assertRuntimeEnvironmentPolicy, buildRuntimeEnvironment, type RuntimeEnvironment, type RuntimeEnvironmentPolicy } from '../../runtime/environment';
import { PI_DURABLE_RUNTIME_CAPABILITIES, PI_RUNTIME_CAPABILITIES } from './pi-capabilities';
import { parsePiAgentResources, INHERITED_PI_AGENT_RESOURCES, type PiAgentResources } from './agent-resources';
import { mcpEventIdentities, type McpEventIdentities } from '../../mcp/event-identity';
import type { RuntimeTaskInput } from '../../types';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import { startDurablePi } from '../pi-durable/session';
import { serializePiHostConfig } from './runtime-host-binding';
import { parsePiMcpEnvironment } from './mcp-environment';
import { piLaunchCommand, resolvePiRuntimeLaunch, type PiRuntimeLaunchResources } from './runtime-launch';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path, { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentEvent,
  ProviderProfileBinding,
} from '@byok-sdk/protocol';
import {
  PolicyUnsupportedError,
  freezeRuntimeAdapterDescriptor,
  type McpStdioServerConfig,
  type McpToolsetToolObservation,
  type RuntimeAdapter,
  type RuntimeDetectResult,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeOperationManifest,
  type RuntimeOperationStartInput,
  type RuntimePreparedLaunchV1,
  type Session,
  type SessionEvidence,
} from '../../types';
import { AGENT_MEMORY_MCP_SERVER_NAME, AGENT_RESULT_MCP_SERVER_NAME, isReservedMcpServerName } from '../../sdk-reserved-mcp';
import { McpAuthorityError } from '../../mcp/authority-error';
import { projectMcpTools, qualifiedMcpToolName } from '../../mcp/projection';
import {
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_VERSION,
} from '../../input-preparation';
import { RuntimeDisposalFailure, RuntimeExecutionFailure, RuntimeStartupDisposalFailure, isRuntimeStartupDisposalFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { clientPackageRoot, readClientPiRuntimePin } from './client-manifest';
import { locateBundledPiAssets } from './todo-locale-assets';
import { BYOK_SDK_HELPER_SUBCOMMAND, resolveSdkReservedHelperBin, type SdkHelperHostConfig } from '../../sdk-reserved-helper-host';
import { resolvePiBin, type ResolvedBin } from './resolve-bin';
import { mapPiContextUsage, mapPiMessageToAgentEvent, ROUTINE_PI_EVENT_TYPES } from './events';
import { PiRpcClient, type PiRpcMessage, type SpawnFn } from './rpc-client';
import { abortPiRpcAndSettle } from './interrupt-settlement';
import { buildPreparedPromptCommand, PREPARED_PROMPT_COMMAND_ID } from './prepared-prompt-frame';
import {
  withoutProviderCredentials,
} from '../provider-credential-environment';
import { probePiAuthPresent } from './auth-presence';
import { startToolAuthorizationIpc } from '../../tool-authorization-ipc';
import { acquirePiSessionRetention, type PiSessionRetentionLease } from '../../util/pi-session-retention';

async function disposePiStartup(rpc: PiRpcClient | undefined, scratch: ExecutionScratch, cause?: unknown): Promise<void> {
  const retry = async (): Promise<void> => {
    if (isRuntimeStartupDisposalFailure(cause)) await cause.retryDisposal();
    await rpc?.dispose();
    await scratch.release();
  };
  try { await retry(); }
  catch (error) { throw new RuntimeStartupDisposalFailure(retry, { cause: new AggregateError([cause, error], 'Pi startup disposal did not complete') }); }
}

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5_000;

/** Package scripts require an interpreter; explicit executable overrides do not. */
function piInvocation(bin: ResolvedBin): { command: string; entry?: string } {
  return bin.source === 'package'
    ? { command: process.execPath, entry: bin.command }
    : { command: bin.command };
}

/** A start request pi's own exit ended is `runtime_exited`. Read before disposal, whose termination also closes the client. */
function startupExit(rpc: PiRpcClient) {
  return rpc.processExited ? { class: 'runtime_exited' as const } : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Pi launch options; execution scratch and replica authority come from start input. */
export interface PiAdapterOptions {
  /** Agent tasks only: exclude user resources/settings while retaining Pi model/auth stores. Default inherit. Not a tool permission. */
  agentUserContext?: 'inherit' | 'excluded';
  /** Agent RPC tasks only: explicit absolute local skill files/directories, including with excluded context. Default []. */
  agentSkillPaths?: readonly string[];
  /** Agent RPC tasks only: trusted executable local extensions, including with excluded context. Default []. */
  agentExtensionPaths?: readonly string[];
  /** Absolute product native asset directory; scoped to this adapter. */
  nativeAssetRoot?: string;
  /** The environment Pi and its MCP servers get (#1095). Default: the login-shell snapshot. */
  runtimeEnvironment?: RuntimeEnvironmentPolicy;
  /** Opt-in ordinary, lease-bound durable worker. */
  durablePi?: boolean;
  /** Override bin resolution — tests substitute the fake-pi fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
  /**
   * Separate-process BYOK credential boundary. The launcher receives only
   * non-secret selection/config paths, resolves the OS credential itself,
   * and transparently proxies the pinned Pi RPC process.
   */
  byokLauncher?: PiByokLauncherConfig;
  /**
   * Re-enter the product's single-file/SEA executable for every Pi launch,
   * as `<executable> [<entry>] __byok_sdk_helper <pi-rpc|pi-prepared|pi-durable>`.
   * The product bundles Pi, so no installed Pi package is resolved.
   */
  sdkHelperHost?: SdkHelperHostConfig;
  /** Admission-time exact local profile check. Tests may replace the process boundary. */
  validateProviderProfileBinding?: (
    binding: ProviderProfileBinding,
    launcher: PiByokLauncherConfig,
  ) => Promise<void>;
}

export interface PiByokLauncherConfig {
  command: string;
  /** Optional fixed launcher arguments, before BYOK's required arguments. */
  args?: string[];
  profileDbPath: string;
  sessionDir: string;
  macosKeychainPath?: string;
  secretServicePrefix?: string;
}

export function validatePiByokLauncherConfig(
  launcher: PiByokLauncherConfig | undefined,
): void {
  if (launcher === undefined) return;

  for (const [field, value] of [
    ['command', launcher.command],
    ['profileDbPath', launcher.profileDbPath],
    ['sessionDir', launcher.sessionDir],
  ] as const) {
    if (value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) {
      throw new Error(`DaemonConfig.piByokLauncher.${field} must be a non-empty single-line string`);
    }
  }
  if (!isAbsolute(launcher.profileDbPath) || !isAbsolute(launcher.sessionDir)) {
    throw new Error(
      'DaemonConfig.piByokLauncher profileDbPath and sessionDir must be absolute paths',
    );
  }
  if (launcher.macosKeychainPath !== undefined && (
    launcher.macosKeychainPath.trim().length === 0 ||
    /[\u0000\r\n]/u.test(launcher.macosKeychainPath)
  )) {
    throw new Error(
      'DaemonConfig.piByokLauncher.macosKeychainPath must be a non-empty single-line string',
    );
  }
  if (launcher.macosKeychainPath !== undefined && !isAbsolute(launcher.macosKeychainPath)) {
    throw new Error(
      'DaemonConfig.piByokLauncher.macosKeychainPath must be an absolute path',
    );
  }
  if (launcher.secretServicePrefix !== undefined && (
    launcher.secretServicePrefix.trim().length === 0 ||
    /[\u0000\r\n]/u.test(launcher.secretServicePrefix)
  )) {
    throw new Error(
      'DaemonConfig.piByokLauncher.secretServicePrefix must be a non-empty single-line string',
    );
  }
  const reserved = new Set([
    '--',
    '--pi-bin',
    '--pi-entry',
    '--pi-cwd',
    '--pi-fixed-args',
    '--pi-projection-dir',
    '--pi-config-digest',
    '--runtime-entry',
    '--profile-db',
    '--session-dir',
    '--macos-keychain-path',
    '--secret-service-prefix',
    '--provider',
    '--model',
    '--profile-revision',
    '--profile-hash',
    '--required-capabilities',
    '--validate-only',
  ]);
  const conflicting = launcher.args?.find((arg) => reserved.has(arg));
  if (conflicting !== undefined) {
    throw new Error(
      `DaemonConfig.piByokLauncher.args must not override reserved launcher argument ${conflicting}`,
    );
  }
  const invalidArg = launcher.args?.find((arg) => arg.length === 0 || /[\u0000\r\n]/u.test(arg));
  if (invalidArg !== undefined) {
    throw new Error('DaemonConfig.piByokLauncher.args must contain only non-empty single-line strings');
  }
}

export class PiAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'pi',
    supportsDispatchSelection: true,
    // Pi registers ONE tool per observed MCP tool, carrying that tool's real
    // schema (`./mcp-extension.ts`), so it consumes the daemon's observation
    // exactly like claude and codex do. It previously declared nothing here
    // because the retired `pi-mcp-adapter` exposed a single `mcp` proxy and
    // discovered the tools behind it itself — which kept the schemas out of
    // the model's first request and left the extension, not the daemon, as the
    // authority on what a toolset contains. Claude and Codex list the tools
    // themselves, so pi is the one bundled adapter that needs this.
    requiresMcpToolsetToolObservation: true,
    // Octop T0 (`docs/notes/2026-10-20-octop-t0-pi-trajectory.md`): Pi 1.3.0
    // pairs `tool_execution_start`/`_end` by `toolCallId` over RPC, and
    // `PiSession` turns only a non-aborted `agent_settled` into `turn_end`.
    trajectoryEvidence: 'event-stream',
    platforms: ['darwin', 'linux', 'win32'],
    capabilities: PI_RUNTIME_CAPABILITIES,
  });

  private readonly agentResources: PiAgentResources;
  private readonly environmentPolicy: RuntimeEnvironmentPolicy;

  constructor(private readonly options: PiAdapterOptions = {}) {
    this.environmentPolicy = assertRuntimeEnvironmentPolicy(options.runtimeEnvironment, 'PiAdapterOptions.runtimeEnvironment');
    this.agentResources = parsePiAgentResources({
      userContext: options.agentUserContext === undefined ? 'inherit' : options.agentUserContext,
      skillPaths: options.agentSkillPaths === undefined ? [] : options.agentSkillPaths,
      extensionPaths: options.agentExtensionPaths === undefined ? [] : options.agentExtensionPaths,
    });
    if (options.durablePi !== undefined && typeof options.durablePi !== 'boolean') throw new Error('PiAdapterOptions.durablePi must be boolean; pass replicaRoot through durableContext');
    // T0 verified the RPC lanes only. The durable worker's own frames and
    // respawn path are unverified, so it declares no trajectory evidence.
    // Windows waits for validated parent-death Job Object recovery.
    if (options.durablePi === true) this.descriptor = freezeRuntimeAdapterDescriptor({ ...this.descriptor, trajectoryEvidence: undefined, platforms: ['darwin', 'linux'], capabilities: PI_DURABLE_RUNTIME_CAPABILITIES });
    validatePiByokLauncherConfig(options.byokLauncher);
    if (options.sdkHelperHost !== undefined) resolveSdkReservedHelperBin('pi-rpc', options.sdkHelperHost);
  }

  runtimeEnvironment(): Promise<RuntimeEnvironment> {
    return buildRuntimeEnvironment(this.environmentPolicy);
  }

  async detect(): Promise<RuntimeDetectResult> {
    try {
      const { env } = await this.runtimeEnvironment();
      const host = this.options.sdkHelperHost;
      if (host !== undefined) {
        // The product bundles Pi at the SDK pin; there is no package to probe.
        // Its asset root must hold the SDK asset manifest. The detect contract
        // carries no reason on `not-found`; a launch states the reason.
        const version = readClientPiRuntimePin();
        if (version === undefined) return { kind: 'not-found' };
        try {
          locateBundledPiAssets({ piPackageDir: env.PI_PACKAGE_DIR, executable: host.executable ?? process.execPath, ...(host.entry === undefined ? {} : { entry: host.entry }) });
        } catch {
          return { kind: 'not-found' };
        }
        const authPresent = await probePiAuthPresent(env);
        return { kind: 'available', version, authPresent };
      }
      const bin = this.resolveBin();
      const invocation = piInvocation(bin);
      const probe = await probeRuntimeVersion(invocation.command, DETECT_TIMEOUT_MS, env,
        invocation.entry === undefined ? [] : [invocation.entry]);
      if (probe.kind !== 'available') return probe;
      const version = probe.stdout.trim() || probe.stderr.trim();
      const authPresent = await probePiAuthPresent(env);
      return { kind: 'available', version, authPresent };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    if (this.options.durablePi === true && process.platform === 'win32') return { kind: 'reject', reason: 'durable Pi is unavailable on Windows until parent-death Job Object recovery is validated', retryable: false };
    if (this.options.durablePi === true && input.offer.dispatchSelection === undefined) {
      return { kind: 'reject', reason: 'durable Pi requires an ordinary BYOK selection', retryable: false };
    }
    // Fail closed BEFORE anything is spawned. pi registers one tool per
    // observed MCP tool, so a projected server with no daemon observation, or
    // an observation it cannot turn into unique runtime tool names, is refused
    // here rather than discovered inside the Pi child at session start, where
    // only the child's stderr would carry the reason.
    const admittedTools = piMcpToolNames(input.mcpServers, input.mcpToolsetTools);
    if (!admittedTools.ok) {
      return {
        kind: 'reject',
        reason: `pi adapter cannot register projected MCP toolset tools: ${admittedTools.reason}`,
        retryable: false,
      };
    }

    // Inline factories are owned by the SDK entry; no runtime extension path resolution here.
    // Session/workspace continuity:
    // `task.sessionRef` is only ever non-empty here when `task-runner.ts`
    // has (a) matched this exact sessionRef in the Agent home's
    // `AgentSessionHandoffStore` and (b) spawned this adapter with
    // `ctx.workspaceDir` set to that SAME recorded cwd — see task-runner.ts's
    // `handleOffer`. That matters because pi's real `--session <id>` resume
    // is scoped to the cwd/project a session was created under: resuming
    // from a *different* cwd prompts an interactive "Session found in
    // different project: ... Fork this session into current directory?
    // [y/N]" pi cannot answer headlessly, and resuming an id pi never
    // minted fails outright (`No session found matching '<id>'`, exit 1 —
    // empirically confirmed against real pi, both live-probed during this
    // task). An absent `sessionRef` always means "start fresh" — pi mints
    // its own session id, which this adapter reads back via `get_state`
    // below and reports as `Session.sessionRef` so a *future* follow-up can
    // resume it. `workspaceHint` remains unimplemented (no
    // caller populates `DispatchInput` with it yet, and its intended
    // semantics — e.g. does it override or merely suggest a workspace
    // relative to the sessionRef mapping? — are still undesigned; see
    // docs/protocol.md §2's note on this field for the explicit
    // reserved/ignored status); a real implementation is a genuine
    // follow-on design task, not a mechanical fix, and is intentionally
    // left alone here. pi 0.84.2 also offers `--session-id`, but that flag
    // creates a missing session. BYOK deliberately uses `--session` so a
    // lost/unknown authoritative sessionRef fails closed instead of silently
    // starting a new history under the requested id.
    const selection = input.offer.dispatchSelection;
    const pinnedSelection: RuntimeTaskInput['dispatchSelection'] = selection === undefined
      ? undefined
      : selection.lane === 'byok-profile'
        ? Object.freeze({
            ...selection,
            providerProfile: Object.freeze({
              ...selection.providerProfile,
              requiredCapabilities: Object.freeze([...selection.providerProfile.requiredCapabilities]),
            }),
          }) as unknown as RuntimeTaskInput['dispatchSelection']
        : Object.freeze({ ...selection }) as RuntimeTaskInput['dispatchSelection'];
    let launcherArgs: string[] | undefined;
    if (pinnedSelection !== undefined) {
      if ((pinnedSelection.lane !== 'byok' && pinnedSelection.lane !== 'byok-profile') || pinnedSelection.runtimeId !== 'pi') {
        return { kind: 'reject', reason: `pi adapter cannot execute ${pinnedSelection.lane} selection for runtime ${pinnedSelection.runtimeId}`, retryable: false };
      }
      const launcher = this.options.byokLauncher;
      if (launcher === undefined) {
        return { kind: 'reject', reason: 'pi BYOK selection requires a configured credential-custody launcher', retryable: false };
      }
      const providerProfile = pinnedSelection.lane === 'byok-profile'
        ? pinnedSelection.providerProfile
        : undefined;
      if (providerProfile !== undefined) {
        try {
          await (this.options.validateProviderProfileBinding ?? validateProviderProfileBindingWithLauncher)(
            providerProfile,
            launcher,
          );
        } catch (error) {
          return {
            kind: 'reject',
            reason: `provider profile admission failed: ${errorMessage(error)}`,
            retryable: false,
          };
        }
      }
      launcherArgs = [
        '--profile-db',
        launcher.profileDbPath,
        '--session-dir',
        launcher.sessionDir,
        ...(launcher.macosKeychainPath !== undefined
          ? ['--macos-keychain-path', launcher.macosKeychainPath]
          : []),
        ...(launcher.secretServicePrefix
          ? ['--secret-service-prefix', launcher.secretServicePrefix]
          : []),
        '--provider',
        providerProfile?.profileRef ?? (pinnedSelection.lane === 'byok' ? pinnedSelection.providerId : ''),
        '--model',
        providerProfile?.modelId ?? (pinnedSelection.lane === 'byok' ? pinnedSelection.modelId : ''),
        ...(providerProfile === undefined ? [] : [
          '--profile-revision', providerProfile.profileRevision,
          '--profile-hash', providerProfile.profileHash,
          '--required-capabilities', JSON.stringify(providerProfile.requiredCapabilities),
          '--validate-only', 'false',
        ]),
      ];
    }

    let boundRuntime: PiRuntimeLaunchResources | undefined;
    let sessionLease: PiSessionRetentionLease | undefined;
    const sessionDir = pinnedSelection === undefined || this.options.durablePi === true ? undefined : this.options.byokLauncher!.sessionDir;
    const acquireSessionLease = async (sessionRef: string) => {
      if (sessionDir === undefined) return undefined;
      if (sessionLease !== undefined) throw authorityFailure('Pi operation already owns a session retention lease');
      sessionLease = await acquirePiSessionRetention(sessionDir, sessionRef);
      return sessionLease;
    };
    return {
      kind: 'prepared',
      operation: {
        acquireSessionLease,
        resolveRuntimeLaunch: async (resources) => {
          if (boundRuntime !== undefined) throw authorityFailure('runtime launch resources were already resolved');
          if (this.options.durablePi === true && resources.kind === 'prepared') throw authorityFailure('durable Pi does not admit the prepared lane');
          const kind = this.options.durablePi === true ? 'pi-durable' : resources.kind === 'prepared' ? 'pi-prepared' : 'pi-rpc';
          boundRuntime = await resolvePiRuntimeLaunch({
            ...resources, sessionCwd: resources.cwd, kind,
            env: pinnedSelection === undefined ? resources.env : withoutProviderCredentials(resources.env),
            resolveInvocation: () => {
              const host = this.options.sdkHelperHost;
              if (host !== undefined) {
                const helper = resolveSdkReservedHelperBin(kind, host);
                try {
                  locateBundledPiAssets({ piPackageDir: resources.env.PI_PACKAGE_DIR, executable: helper.command, ...(host.entry === undefined ? {} : { entry: host.entry }) });
                } catch (error) {
                  throw authorityFailure(error instanceof Error ? error.message : String(error), error);
                }
                return { command: helper.command, ...(host.entry === undefined ? {} : { entry: host.entry }),
                  fixedArgs: [BYOK_SDK_HELPER_SUBCOMMAND, kind] };
              }
              // Resolve the installed Pi package before choosing the SDK entry.
              const bin = this.resolveBin();
              if (kind === 'pi-durable') return { command: process.execPath, entry: path.join(clientPackageRoot(), 'dist', 'bin', 'byok-pi-durable.js') };
              if (kind === 'pi-prepared') return { command: process.execPath, entry: preparedPiLaunchBin() };
              return this.options.resolveBin === undefined
                ? { command: process.execPath, entry: path.join(clientPackageRoot(), 'dist', 'bin', 'byok-pi-rpc.js') }
                : piInvocation(bin);
            },
            // BOTH entries, once a BYOK profile is pinned. The session dir is
            // what turns the launch into `credentialSource: 'keys-profile'` and
            // a fresh 0700 per-launch projection directory. The device secret
            // reaches the Pi child only through the keys launcher.
            ...(pinnedSelection !== undefined
              ? { keysSessionDir: this.options.byokLauncher!.sessionDir } : {}),
          });
          return boundRuntime;
        },
        start: async (startInput: RuntimeOperationStartInput): Promise<Session> => {
          const runtimeLaunch = startInput.runtimeLaunch;
          if (runtimeLaunch === undefined || runtimeLaunch !== boundRuntime) throw authorityFailure('Pi start requires its resolved runtime launch');
          if (runtimeLaunch.scratch !== startInput.scratch) throw authorityFailure('Pi start scratch differs from runtime launch');
          if (runtimeLaunch.kind !== (this.options.durablePi === true ? 'pi-durable' : startInput.kind === 'prepared' ? 'pi-prepared' : 'pi-rpc')) throw authorityFailure('Pi start lane differs from runtime launch');
          if (runtimeLaunch.sessionCwd !== startInput.manifest.cwd) throw authorityFailure('Pi runtime session cwd differs from manifest');
          const resources = startInput.manifest.agentRef === undefined ? INHERITED_PI_AGENT_RESOURCES : this.agentResources;
          if ((resources.userContext === 'excluded' || resources.skillPaths.length > 0 || resources.extensionPaths.length > 0) && runtimeLaunch.kind !== 'pi-rpc') {
            throw authorityFailure('Pi Agent resources are supported only by the ordinary RPC lane');
          }
          if (startInput.toolAuthorization !== undefined && runtimeLaunch.kind !== 'pi-rpc') {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'semantic', retry: 'non-retryable',
              reason: 'tool_authorization_unsupported: only the ordinary Pi RPC lane gates tool calls before execution',
            });
          }
          parsePiMcpEnvironment(startInput.mcpEnv);
          const mcpEnv = startInput.mcpEnv!; // Preserve the daemon admission object through serialization.
          const manifestSelection = startInput.manifest.dispatchSelection;
          if (!sameDispatchSelection(manifestSelection, pinnedSelection)) {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation received a manifest with different runtime selection',
            });
          }
          const manifestCwd = startInput.manifest.cwd;
          if (manifestCwd === undefined) {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation received a manifest without a sealed cwd',
            });
          }
          // The tool set this operation was ADMITTED with was resolved from the
          // prepare() input; the resources handed to start() are a separate
          // object. pi writes the servers plus the daemon's observation into
          // the task-scoped MCP config the extension registers from, so without
          // this comparison a caller could swap in a different tool observation
          // between admission and start and the child would register the
          // swapped set. It runs BEFORE the task config is written.
          const startTools = piMcpToolNames(startInput.mcpServers, startInput.mcpToolsetTools);
          if (!startTools.ok || startTools.names !== admittedTools.names) {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation received different MCP toolset tool authority than it was admitted with',
            });
          }
          // The prepared lane diverges here, AFTER every authority check both
          // lanes share: the same sealed selection, the same sealed cwd and the
          // same registered MCP tool set. What it does not share is the CLI —
          // `pi --mode rpc` can never consume a prepared request, so this branch
          // launches the SDK-owned in-process host instead
          // (`../../bin/byok-pi-prepared.ts`).
          if (this.options.durablePi === true) {
            if (startInput.kind !== 'instruction' || launcherArgs === undefined || this.options.byokLauncher === undefined) throw authorityFailure('durable Pi requires ordinary custody launch');
            if (startInput.durableContext === undefined) throw authorityFailure('durable Pi requires replica and journal context');
            return await startDurablePi({ input: startInput, runtimeLaunch, replicaRoot: startInput.durableContext.replicaRoot,
              launcher: this.options.byokLauncher, launcherArgs, nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn });
          }
          if (startInput.kind === 'prepared') {
            return await startPreparedPiOperation({
              runtimeLaunch,
              scratch: startInput.scratch,
              mcpEnv,
              preparation: startInput.preparation,
              manifest: startInput.manifest,
              manifestCwd,
              manifestSelection,
              env: startInput.env,
              // Present exactly when a BYOK profile is pinned, which is also
              // exactly when the runtime launch carries `keys-profile`. The
              // two are checked against each other below rather than trusted
              // to agree.
              ...(launcherArgs === undefined ? {} : {
                launcher: Object.freeze({
                  command: this.options.byokLauncher!.command,
                  args: Object.freeze([...(this.options.byokLauncher!.args ?? [])]),
                  profileArgs: Object.freeze([...launcherArgs]),
                }),
              }),
              ...(startInput.mcpServers === undefined ? {} : { mcpServers: startInput.mcpServers }),
              ...(startInput.mcpToolsetTools === undefined ? {} : { mcpToolsetTools: startInput.mcpToolsetTools }),
              nativeAssetRoot: this.options.nativeAssetRoot,
              ...(this.options.spawnFn === undefined ? {} : { spawnFn: this.options.spawnFn }),
            });
          }
          if (typeof startInput.instruction !== 'string') {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation requires a resolved string instruction',
            });
          }
          const resumeSessionId = startInput.manifest.sessionRef;
          if (startInput.sessionLease !== undefined && (startInput.sessionLease !== sessionLease || sessionLease?.sessionRef !== resumeSessionId)) {
            throw authorityFailure("Pi start requires this operation's exact session retention lease");
          }
          if (sessionLease !== undefined) {
            if (startInput.sessionLease !== sessionLease) throw authorityFailure('Pi resume lease was not passed to start');
            sessionLease.assertHeld();
          } else if (resumeSessionId !== undefined) {
            // Standalone callers have no daemon handoff stage, but share its retention authority.
            await acquireSessionLease(resumeSessionId);
          }
          let mcpConfigDir: string | undefined;
          let runtimeEnv = { ...runtimeLaunch.env };
          const taskMcpServers = startInput.mcpServers ?? {};
          let hostConfigDigest: string;
          let hostConfigPath: string;
          let scratch = Object.freeze({ ...startInput.scratch, release: async () => {
            await startInput.scratch.release();
            // An admission caller owns its token through terminal persistence;
            // standalone/fresh starts own theirs through runtime disposal.
            if (startInput.sessionLease === undefined) await sessionLease?.release();
          } });
          try {
            const gate = startInput.toolAuthorization === undefined ? undefined : await startToolAuthorizationIpc(startInput.toolAuthorization);
            const retainedScratch = scratch;
            if (gate !== undefined) scratch = Object.freeze({ ...scratch, release: async () => {
              await gate.close();
              await retainedScratch.release();
            } });
            // The scratch's sdk directory is created 0700. Launch files in it are
            // created 0600 ('wx': a new file, so the mode applies at creation)
            // and removed on every start failure and on close. The host config holds
            // `mcpEnv`, which already has no provider credential names
            // (`projectPiMcpEnvironment`).
            mcpConfigDir = startInput.scratch.sdkDir;
            await fs.chmod(mcpConfigDir, 0o700).catch(() => {});
            hostConfigPath = path.join(mcpConfigDir, 'rpc-launch.json');
            // The daemon's observation travels WITH the servers: the extension
            // registers exactly the tools named here and discovers nothing of
            // its own, so the tools the model is shown are the tools this task
            // was admitted with.
            //
            // What is written is the START observation, already compared
            // above with the one this operation was admitted with.
            const serialized = serializePiHostConfig({
              format: 'byok.pi.rpc-launch', version: 8,
              // Digest-bound, as in the prepared lane: under `keys-profile`
              // the host takes the provider key over the launcher's private
              // IPC channel and refuses to start without it.
              credentialSource: runtimeLaunch.credentialSource,
              cwd: runtimeLaunch.sessionCwd,
              agentUserContext: resources.userContext,
              agentSkillPaths: resources.skillPaths,
              agentExtensionPaths: resources.extensionPaths,
              toolAuthorization: gate?.config ?? null,
              mcp: {
                mcpEnv,
                mcpServers: taskMcpServers,
                observation: startInput.mcpToolsetTools ?? {},
                // The servers start in the session cwd, as in OAR.
                launchCwd: runtimeLaunch.sessionCwd,
              },
            });
            hostConfigDigest = serialized.digest;
            await fs.writeFile(hostConfigPath, serialized.bytes, { mode: 0o600, flag: 'wx' });
          } catch (cause) {
            await scratch.release();
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'infrastructure', retry: 'retryable',
              reason: 'pi task-scoped MCP configuration could not be created',
            }, { cause });
          }
          const piArgs = ['--config', hostConfigPath, '--mode', 'rpc',
            ...(resumeSessionId === undefined ? [] : ['--session', resumeSessionId])];
          const launch = piLaunchCommand(runtimeLaunch, 'pi-rpc', hostConfigDigest, piArgs,
            launcherArgs === undefined ? undefined : {
              command: this.options.byokLauncher!.command,
              args: this.options.byokLauncher!.args ?? [],
              profileArgs: launcherArgs,
            });
          let rpc: PiRpcClient;
          try {
            rpc = new PiRpcClient({
              command: launch.command,
              args: launch.args,
              cwd: runtimeLaunch.cwd,
              env: runtimeEnv,
              nativeAssetRoot: this.options.nativeAssetRoot, spawnFn: this.options.spawnFn,
            });
          } catch (cause) {
            await disposePiStartup(undefined, scratch, cause);
            if (cause instanceof RuntimeExecutionFailure) throw cause;
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'infrastructure', retry: 'retryable',
              reason: 'pi runtime process could not be spawned',
            }, { cause });
          }

          // The host owns its writer lease before serving get_state. The parent
          // retains admission too, before allowing the first prompt.
          let sessionRef: string;
          try {
            sessionRef = await resolveAuthoritativeSessionId(rpc);
            if (resumeSessionId !== undefined && sessionRef !== resumeSessionId) {
              throw authorityFailure('pi resumed a different authoritative session than requested');
            }
            if (sessionDir !== undefined && sessionLease === undefined) await acquireSessionLease(sessionRef);
          } catch (cause) {
            await disposePiStartup(rpc, scratch, cause);
            throw cause;
          }
          let response: PiRpcMessage;
          try {
            response = await rpc.send({ type: 'prompt', message: startInput.instruction });
          } catch (cause) {
            const failure = startupExit(rpc);
            await disposePiStartup(rpc, scratch);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'infrastructure', retry: 'retryable',
              reason: `pi initial prompt transport failed: ${errorMessage(cause)}`, failure,
            }, { cause });
          }
          if (response.success === false) {
            await disposePiStartup(rpc, scratch);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'semantic', retry: 'non-retryable',
              reason: typeof response.error === 'string' ? response.error : 'pi rejected the initial prompt',
            });
          }

          return new PiSession(sessionRef, rpc, manifestSelection, scratch, undefined, mcpEventIdentities(startInput.mcpToolsetTools));
        },
      },
    };
  }

  private resolveBin(): ResolvedBin {
    return (this.options.resolveBin ?? resolvePiBin)();
  }
}

/**
 * The qualified MCP tool names pi registers for one task, as one comparable
 * string, or the reason the observation cannot be registered.
 *
 * Every projected host toolset server must arrive with a daemon observation,
 * and the observation may name no server the task was not given. SDK-reserved
 * helpers carry their own fixed tools and are never observed.
 */
function piMcpToolNames(
  servers: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  observation: McpToolsetToolObservation | undefined,
): { readonly ok: true; readonly names: string } | { readonly ok: false; readonly reason: string } {
  const projected = Object.keys(servers ?? {}).filter((name) => !isReservedMcpServerName(name)).sort();
  const observed = observation ?? {};
  const unexpected = Object.keys(observed).filter((name) => !projected.includes(name)).sort();
  if (unexpected.length > 0) {
    return { ok: false, reason: `observed MCP server(s) [${unexpected.join(', ')}] are not projected for this task` };
  }
  const missing = projected.filter((name) => (observed[name]?.tools.length ?? 0) === 0);
  if (missing.length > 0) {
    return { ok: false, reason: `no tools/list observation for projected MCP toolset server(s) [${missing.join(', ')}]` };
  }
  try {
    const names = projectMcpTools(observed).map((tool) => qualifiedMcpToolName(tool.serverName, tool.toolName));
    return { ok: true, names: names.join('\n') };
  } catch (error) {
    if (error instanceof McpAuthorityError) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * Everything one prepared pi launch needs, after both lanes' shared authority
 * checks have already passed.
 */
interface PreparedPiLaunchInput {
  nativeAssetRoot?: string;
  readonly scratch: ExecutionScratch;
  readonly mcpEnv: Readonly<Record<string, string>>;
  readonly runtimeLaunch: PiRuntimeLaunchResources;
  readonly preparation: RuntimePreparedLaunchV1;
  readonly manifest: RuntimeOperationManifest;
  readonly manifestCwd: string;
  readonly manifestSelection: RuntimeTaskInput['dispatchSelection'];
  readonly env: NodeJS.ProcessEnv;
  /**
   * The credential-custody launcher this operation must be parented by, and
   * the profile flags the adapter already resolved for it. Absent means no
   * BYOK profile was pinned, which is the declared built-in-provider entry —
   * not a fallback, and never a place to invent a launcher.
   */
  readonly launcher?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly profileArgs: readonly string[];
  };
  readonly mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  readonly mcpToolsetTools?: McpToolsetToolObservation;
  readonly spawnFn?: SpawnFn;
}

/**
 * Keep the SDK-owned memory helper outside the Host MCP projection. Its
 * descriptor lives on the prepared-memory branch; it cannot acquire a
 * synthetic Host toolset identity by entering the pool map.
 */
function splitPreparedSdkServers(
  servers: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  mode: RuntimePreparedLaunchV1['agentMemory'],
  terminalProjection: RuntimePreparedLaunchV1['terminalProjection'],
): {
  readonly hostServers: Readonly<Record<string, McpStdioServerConfig>>;
  readonly memoryCall: McpStdioServerConfig | null;
  readonly resultCall: McpStdioServerConfig | null;
} {
  const memoryCall = servers?.[AGENT_MEMORY_MCP_SERVER_NAME] ?? null;
  if (mode === 'none') {
    if (memoryCall !== null) throw authorityFailure('prepared pi operation received an Agent memory helper without a sealed memory selection');
  } else if (memoryCall === null) {
    throw authorityFailure('prepared pi operation received no task-bound Agent memory helper for its sealed memory selection');
  }
  const resultCall = servers?.[AGENT_RESULT_MCP_SERVER_NAME] ?? null;
  if (terminalProjection?.mode === 'result-document' ? resultCall === null : resultCall !== null) {
    throw authorityFailure('prepared pi result helper does not agree with its frozen result selection');
  }
  const hostServers: Record<string, McpStdioServerConfig> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (name !== AGENT_MEMORY_MCP_SERVER_NAME && name !== AGENT_RESULT_MCP_SERVER_NAME) hostServers[name] = server;
  }
  return Object.freeze({ hostServers: Object.freeze(hostServers), memoryCall, resultCall });
}

function authorityFailure(reason: string, cause?: unknown): RuntimeExecutionFailure {
  return new RuntimeExecutionFailure(
    { phase: 'start', category: 'authority', retry: 'non-retryable', reason },
    ...(cause === undefined ? [] : [{ cause }]),
  );
}

/**
 * Read the retained artifact this operation was counted for.
 *
 * The record's own identity is re-checked against the file: an artifact is
 * addressed by path here, and a path is not an identity. Nothing else about the
 * file is interpreted — the envelope crosses to the native session verbatim,
 * because the native compiler is the only authority on what those bytes mean.
 *
 * Asynchronous because this runs on the daemon's own loop: a retained artifact
 * carries D, P(D) and the whole native envelope, and reading megabytes of it
 * synchronously would stall every other task's cancel, approval and heartbeat
 * for the duration.
 */
async function readPreparedArtifact(preparation: RuntimePreparedLaunchV1): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(preparation.artifactPath, 'utf8'));
  } catch (cause) {
    throw authorityFailure('prepared pi operation could not read its counted artifact', cause);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw authorityFailure('prepared pi operation read an artifact that is not an object');
  }
  const artifact = parsed as Record<string, unknown>;
  if (artifact.format !== INPUT_PREPARATION_ARTIFACT_FORMAT || artifact.version !== INPUT_PREPARATION_VERSION) {
    throw authorityFailure('prepared pi operation read an artifact of an unrecognized format');
  }
  if (artifact.recordId !== preparation.reference.recordId) {
    throw authorityFailure('prepared pi operation read an artifact belonging to a different preparation record');
  }
  if (artifact.envelopeDigest !== preparation.expected.envelopeDigest) {
    throw authorityFailure('prepared pi operation read an artifact whose envelope digest is not the recorded one');
  }
  if (artifact.toolManifestDigest !== preparation.expected.toolManifestDigest) {
    throw authorityFailure('prepared pi operation read an artifact whose tool manifest digest is not the recorded one');
  }
  if (artifact.envelope === undefined) {
    throw authorityFailure('prepared pi operation read an artifact that retains no native envelope');
  }
  return artifact.envelope;
}

/**
 * Launch one prepared Execution.
 *
 * The shape of this lane, and what each step is FOR:
 *
 * 1. Q2 — a prepared Execution never resumes. A `sessionRef` and a prepared
 *    reference together are refused here rather than reconciled: resuming binds
 *    the frozen request to a history that was not part of what was counted, and
 *    the native session would reject it as `prepared_context_drift` after the
 *    process, the servers and the session file already existed.
 * 2. The counted mode and the admitted mode must be the same mode, and the
 *    implementation identities this task resolved must be the ones the
 *    preparation bound. These are the adapter's own fail-closed
 *    re-checks, on the same shape as the MCP grant fingerprint the shared path
 *    already compares; the child re-derives the digests independently anyway,
 *    so a divergence that slips past here still fails closed — just later and
 *    with a less specific reason.
 * 3. The task-scoped configuration is written, the in-process host is spawned,
 *    and the frozen envelope is sent as ONE `prompt_prepared` command. The SDK
 *    asserts equality on the response (`sessionId`, `preparedDigest`) and never
 *    re-sends: no prepared failure code is retryable with different input, so
 *    there is no second attempt to write.
 */
async function startPreparedPiOperation(input: PreparedPiLaunchInput): Promise<Session> {
  const { preparation } = input;
  if (input.manifest.sessionRef !== undefined) {
    throw authorityFailure(
      'a prepared pi operation never resumes a session; a sealed sessionRef and a prepared reference are refused'
      + ' together',
    );
  }
  if (input.manifest.agentMemory !== preparation.agentMemory) {
    throw authorityFailure('prepared pi operation received a manifest whose Agent memory selection differs from its sealed preparation');
  }
  const memoryServer = splitPreparedSdkServers(input.mcpServers, preparation.agentMemory, preparation.terminalProjection);

  // The launch resources and the pinned selection must agree about where this
  // operation's credential comes from. `resolvePiRuntimeLaunch` derives
  // `keys-profile` from the keys session directory and the adapter passes that
  // directory for exactly the selections it resolved launcher flags for, so a
  // disagreement here is a wiring fault, not a configuration a caller chose —
  // and a prepared host started under the wrong source would either read the
  // device's Pi auth store or wait for a secret nobody is delivering.
  const credentialSource = input.runtimeLaunch.credentialSource;
  if ((credentialSource === 'keys-profile') !== (input.launcher !== undefined)) {
    throw authorityFailure(
      credentialSource === 'keys-profile'
        ? 'prepared pi BYOK operation requires a configured credential-custody launcher'
        : 'prepared pi operation resolved a credential-custody launcher for a launch that is not keys-profile',
    );
  }

  const envelope = await readPreparedArtifact(preparation);

  let configDir: string | undefined;
  let configPath: string;
  let configDigest: string;
  try {
    configDir = input.scratch.sdkDir;
    await fs.chmod(configDir, 0o700).catch(() => {});
    configPath = path.join(configDir, 'prepared-launch.json');
    const serialized = serializePiHostConfig({
        format: 'byok.pi.prepared-launch',
        version: 6,
        // The host's single branch switch. It is not a second opinion about
        // the launch: it is `resolvePiRuntimeLaunch`'s own decision carried to
        // the process that must act on it, and it travels inside the
        // digest-bound configuration rather than as an argument the spawn
        // could be given separately.
        credentialSource,
        cwd: input.manifestCwd,
        expected: { model: preparation.expected.model },
        toolBindingDigest: preparation.toolBindingDigest,
        observationDigest: preparation.observationDigest,
        toolsetDefinitionRevisions: preparation.toolsetDefinitionRevisions,
        agentMemory: preparation.agentMemory,
        memory: preparation.memory,
        memoryCall: memoryServer.memoryCall,
        terminalProjection: preparation.terminalProjection ?? null,
        resultCall: memoryServer.resultCall,
        // The SAME task-scoped MCP shape the ordinary extension reads, written
        // by the same adapter from the same resources. The prepared host parses
        // it with the same parser and reaches the servers through the same pool.
        mcp: {
          mcpEnv: input.mcpEnv,
          mcpServers: memoryServer.hostServers,
          observation: input.mcpToolsetTools ?? {},
          launchCwd: input.manifestCwd,
        },
      });
    configDigest = serialized.digest;
    await fs.writeFile(configPath, serialized.bytes, { mode: 0o600 });
  } catch (cause) {
    await input.scratch.release();
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'infrastructure', retry: 'retryable',
      reason: 'pi prepared launch configuration could not be created',
    }, { cause });
  }

  let rpc: PiRpcClient;
  try {
    // Without a BYOK profile this is a direct spawn that reads the device's
    // own Pi auth store. With one, the keys launcher sits between this process
    // and the host: it is the only code that opens the device SecretStore.
    const launch = piLaunchCommand(input.runtimeLaunch, 'pi-prepared', configDigest, ['--config', configPath], input.launcher);
    rpc = new PiRpcClient({
      command: launch.command,
      args: launch.args,
      cwd: input.runtimeLaunch.cwd,
      env: input.runtimeLaunch.env,
      nativeAssetRoot: input.nativeAssetRoot,
      ...(input.spawnFn === undefined ? {} : { spawnFn: input.spawnFn }),
    });
  } catch (cause) {
    await disposePiStartup(undefined, input.scratch, cause);
    if (cause instanceof RuntimeExecutionFailure) throw cause;
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'infrastructure', retry: 'retryable',
      reason: 'pi prepared runtime process could not be spawned',
    }, { cause });
  }

  let response: PiRpcMessage;
  try {
    // The SAME builder the preparation service measured against the runtime's
    // RPC frame cap (`daemon/input-preparation-service.ts`). The id is stated,
    // not left to the transport, so the frame that was admitted is the frame
    // that is written.
    response = await rpc.send(buildPreparedPromptCommand(envelope, preparation.expected, PREPARED_PROMPT_COMMAND_ID));
  } catch (cause) {
    const failure = startupExit(rpc);
    await disposePiStartup(rpc, input.scratch);
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'infrastructure', retry: 'retryable',
      reason: `pi prepared request transport failed: ${errorMessage(cause)}`, failure,
    }, { cause });
  }
  if (response.success === false) {
    await disposePiStartup(rpc, input.scratch);
    // The native code is reported verbatim. Every one of them is terminal for
    // this artifact — nothing here retries, and nothing here may re-send a
    // DIFFERENT input under the same accounting.
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'semantic', retry: 'non-retryable',
      reason: `pi refused the prepared request (${typeof response.code === 'string' ? response.code : 'prepared_failed'})`
        + `: ${typeof response.error === 'string' ? response.error : 'no reason reported'}`,
    });
  }

  const data = response.data as { sessionId?: unknown; preparedDigest?: unknown } | undefined;
  if (typeof data?.sessionId !== 'string' || data.sessionId.length === 0) {
    await disposePiStartup(rpc, input.scratch);
    throw authorityFailure('pi admitted the prepared request without reporting an authoritative session id');
  }
  if (data.preparedDigest !== preparation.expected.envelopeDigest) {
    await disposePiStartup(rpc, input.scratch);
    throw authorityFailure('pi admitted a prepared request whose digest is not the one this operation counted');
  }
  const sessionRef = data.sessionId;

  let state: PiRpcMessage;
  try {
    state = await rpc.send({ type: 'get_state' });
  } catch (cause) {
    const failure = startupExit(rpc);
    await disposePiStartup(rpc, input.scratch);
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'infrastructure', retry: 'retryable',
      reason: `pi transport ended before confirming the prepared session id: ${errorMessage(cause)}`, failure,
    }, { cause });
  }
  const stateData = state.data as { sessionId?: unknown } | undefined;
  if (state.success === false || stateData?.sessionId !== sessionRef) {
    await disposePiStartup(rpc, input.scratch);
    throw authorityFailure('pi reported a different session id than the one that admitted the prepared request');
  }

  return new PiSession(sessionRef, rpc, input.manifestSelection, input.scratch, preparation.expected.model.contextWindow, mcpEventIdentities(input.mcpToolsetTools));
}

/**
 * The shipped prepared launch entry.
 *
 * Used only for an explicitly unconfigured dev launch. Configured authorities
 * supply their measured SDK entry through the runtime launch description.
 */
function preparedPiLaunchBin(): string {
  return path.join(clientPackageRoot(), 'dist', 'bin', 'byok-pi-prepared.js');
}

async function validateProviderProfileBindingWithLauncher(
  binding: ProviderProfileBinding,
  launcher: PiByokLauncherConfig,
): Promise<void> {
  await execFileAsync(launcher.command, [
    ...(launcher.args ?? []),
    '--pi-bin', process.execPath,
    // Admission runs at prepare(), before either lane is chosen, and it never
    // spawns a child — so it asks the rpc entry's question, which is the
    // profile admission both lanes share. The prepared entry's additional
    // support-set refusals are stated by the launch invocation itself, which
    // passes `--runtime-entry pi-prepared` and refuses before any host exists.
    '--runtime-entry', 'pi-rpc',
    '--profile-db', launcher.profileDbPath,
    '--session-dir', launcher.sessionDir,
    '--provider', binding.profileRef,
    '--model', binding.modelId,
    '--profile-revision', binding.profileRevision,
    '--profile-hash', binding.profileHash,
    '--required-capabilities', JSON.stringify(binding.requiredCapabilities),
    '--validate-only', 'true',
    ...(launcher.macosKeychainPath !== undefined
      ? ['--macos-keychain-path', launcher.macosKeychainPath]
      : []),
    ...(launcher.secretServicePrefix
      ? ['--secret-service-prefix', launcher.secretServicePrefix]
      : []),
  ], { timeout: DETECT_TIMEOUT_MS });
}

/**
 * Compare two dispatch selections field-for-field within their own lane.
 *
 * The lanes do not share an identity shape: `subscription` and `byok` pin a
 * flat `providerId`/`modelId` pair, while `byok-profile` pins an exact local
 * provider profile (ref, revision, hash, model, and the capabilities the task
 * requires). Comparing only the fields one lane happens to expose would let a
 * manifest carrying a *different* profile pass the start-time authority check,
 * so each lane is compared on everything that lane seals — including
 * `requiredCapabilities` in order, since the sealed array is the exact value
 * the manifest froze rather than a set.
 */
function sameDispatchSelection(
  left: RuntimeTaskInput['dispatchSelection'],
  right: RuntimeTaskInput['dispatchSelection'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.lane === 'byok-profile' || right.lane === 'byok-profile') {
    if (left.lane !== 'byok-profile' || right.lane !== 'byok-profile') return false;
    if (left.runtimeId !== right.runtimeId) return false;
    const leftProfile = left.providerProfile;
    const rightProfile = right.providerProfile;
    return leftProfile.profileRef === rightProfile.profileRef &&
      leftProfile.profileRevision === rightProfile.profileRevision &&
      leftProfile.profileHash === rightProfile.profileHash &&
      leftProfile.modelId === rightProfile.modelId &&
      leftProfile.requiredCapabilities.length === rightProfile.requiredCapabilities.length &&
      leftProfile.requiredCapabilities.every(
        (capability, index) => capability === rightProfile.requiredCapabilities[index],
      );
  }
  return left.lane === right.lane &&
    left.runtimeId === right.runtimeId &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId;
}

/**
 * Learn pi's own real session id for a freshly-started (non-resume) run, so
 * `Session.sessionRef` reports something a *future* follow-up can actually
 * resume via `--session <id>`. `get_state.data.sessionId` is populated from
 * the moment pi's RPC process boots (confirmed live: present even before
 * any prompt is sent, with `messageCount: 0`), so this is called
 * before the initial prompt. The host already holds its writer lease.
 *
 * Finding F8 (fabricated sessionRef): this used to fall back to
 * `crypto.randomUUID()` whenever `get_state` failed, timed out, or omitted
 * `sessionId` — minting an id pi itself never knew about, which could never
 * actually be resumed and silently looked like a legitimate, resumable
 * session to every caller (`TaskRunner`'s `AgentSessionHandoffStore`, a future
 * follow-up's `task.offer.sessionRef`, etc). Fail closed instead: if pi
 * doesn't hand back an authoritative session id, `start()` itself fails
 * with the real underlying error (stderr context is already folded in when
 * the rejection comes from the process exiting — see
 * `PiRpcClient.buildExitError`), exactly like any other adapter start()
 * failure `task-runner.ts` already knows how to report as `task.fail`.
 */
async function resolveAuthoritativeSessionId(rpc: PiRpcClient): Promise<string> {
  let state: PiRpcMessage;
  try {
    state = await rpc.send({ type: 'get_state' });
  } catch (err) {
    if (isRuntimeExecutionFailure(err)) throw err;
    throw new RuntimeExecutionFailure({
      phase: 'start',
      category: 'infrastructure',
      retry: 'retryable',
      reason: `pi transport ended before yielding an authoritative session id: ${errorMessage(err)}`,
      failure: startupExit(rpc),
    }, {
      cause: err,
    });
  }

  if (state.success === false) {
    const reason = typeof state.error === 'string' ? state.error : 'get_state reported failure';
    throw new RuntimeExecutionFailure({
      phase: 'start',
      category: 'authority',
      retry: 'non-retryable',
      reason: `pi did not yield an authoritative session id: ${reason}`,
    });
  }

  const data = state.data as { sessionId?: unknown } | undefined;
  if (typeof data?.sessionId === 'string' && data.sessionId.length > 0) {
    return data.sessionId;
  }

  throw new RuntimeExecutionFailure({
    phase: 'start',
    category: 'authority',
    retry: 'non-retryable',
    reason: 'pi get_state reported no authoritative session id',
  });
}

class PiSession implements Session {
  private pendingTurnEnd = false;
  private closeAttempt: Promise<void> | undefined;

  constructor(
    public readonly sessionRef: string,
    private readonly rpc: PiRpcClient,
    private readonly selection: RuntimeTaskInput['dispatchSelection'],
    /** Task-scoped isolated MCP extension configuration, removed in close(). */
    private readonly scratch: ExecutionScratch,
    private readonly hostContextWindow?: number,
    private readonly identities?: McpEventIdentities,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const rpc = this.rpc;
    const hostContextWindow = this.hostContextWindow;
    const session = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        const inner = rpc.events[Symbol.asyncIterator]();
        let terminalFailure: RuntimeExecutionFailure | undefined;
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            for (;;) {
              if (session.pendingTurnEnd) { session.pendingTurnEnd = false; return { value: { type: 'turn_end' }, done: false }; }
              if (terminalFailure) throw terminalFailure;
              let result: IteratorResult<PiRpcMessage>;
              try {
                result = await inner.next();
              } catch (cause) {
                throw new RuntimeExecutionFailure({
                  phase: 'run',
                  category: 'infrastructure',
                  retry: 'retryable',
                  reason: 'pi runtime event transport failed',
                }, { cause });
              }
              const { value, done } = result;
              if (done) {
                throw new RuntimeExecutionFailure({
                  phase: 'run',
                  category: 'infrastructure',
                  retry: 'retryable',
                  reason: 'pi runtime process ended before agent_settled',
                  failure: { class: rpc.processExited ? 'runtime_exited' : 'unknown' },
                }, { cause: rpc.terminalError });
              }
              if (value.type === 'agent_settled') {
                // Native abort is terminal authority before optional statistics.
                // A failed statistics read must not make an aborted run retryable.
                const abortFailure = value.aborted === true ? new RuntimeExecutionFailure({
                  phase: 'run', category: 'semantic', retry: 'non-retryable',
                  reason: 'pi run aborted before completion',
                }) : undefined;
                if (abortFailure) terminalFailure = abortFailure;
                // Read after settlement and deliver before turn_end, where the consumer stops.
                let timer: ReturnType<typeof setTimeout> | undefined;
                let stats: PiRpcMessage | undefined;
                try {
                  stats = await Promise.race([rpc.send({ type: 'get_session_stats' }),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RuntimeExecutionFailure({
                      phase: 'run', category: 'infrastructure', retry: 'retryable',
                      reason: 'pi get_session_stats response timed out',
                    })), 1000); }),
                  ]);
                } catch (cause) {
                  if (!abortFailure) throw cause;
                  // Deliver unavailable usage, then the already-recorded abort.
                  // TaskRunner continues to own requested cancellation during teardown.
                } finally { if (timer !== undefined) clearTimeout(timer); }
                if (!abortFailure) session.pendingTurnEnd = true;
                return { value: mapPiContextUsage(stats?.success === false ? undefined : stats?.data, hostContextWindow), done: false };
              }
              const mapped = mapPiMessageToAgentEvent(value, session.identities);
              if (value.type === 'auto_retry_end' && value.success === false) {
                terminalFailure = new RuntimeExecutionFailure({
                  phase: 'run',
                  category: 'semantic',
                  retry: 'non-retryable',
                  reason: 'pi exhausted its native retry policy',
                });
              }
              if (mapped) return { value: mapped, done: false };
              // Unmapped pi message: routine bookkeeping (compaction/retry/
              // session events — see ROUTINE_PI_EVENT_TYPES) is silently
              // ignored, same as before; anything else is genuinely
              // unexpected traffic worth flagging (see recordUnmappedFrame's
              // doc comment) — keep pulling either way, never surfaced.
              if (!ROUTINE_PI_EVENT_TYPES.has(value.type)) {
                rpc.recordUnmappedFrame(value.type);
              }
            }
          },
        };
      },
    };
  }

  async steer(text: string): Promise<void> {
    await this.rpc.send({ type: 'steer', message: text });
  }

  async followUp(task: RuntimeTaskInput): Promise<void> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('pi adapter only supports string instructions in M0 (no blob-ref fetch yet)');
    }
    const requestedSelection = task.dispatchSelection;
    if (requestedSelection !== undefined && (
      this.selection?.lane !== 'byok' ||
      requestedSelection.lane !== 'byok' ||
      requestedSelection.runtimeId !== 'pi' ||
      requestedSelection.providerId !== this.selection.providerId ||
      requestedSelection.modelId !== this.selection.modelId
    )) {
      throw new PolicyUnsupportedError(
        'pi persistent session cannot change its authoritative BYOK provider/model selection',
      );
    }
    await this.rpc.send({ type: 'prompt', message: task.instruction, streamingBehavior: 'followUp' });
  }

  async interrupt(): Promise<void> {
    await abortPiRpcAndSettle(this.rpc);
  }

  async close(): Promise<void> {
    if (!this.closeAttempt) {
      const attempt = (async () => {
        await this.rpc.dispose();
        await this.scratch.release();
      })();
      this.closeAttempt = attempt.catch((error: unknown) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }

  /** Pi reports every tool result itself; this adapter never makes one up. */
  evidence(): SessionEvidence {
    return { decodeDropped: this.rpc.decodeDropped, unmappedFrames: this.rpc.unmappedFrames, syntheticToolResults: 0 };
  }
}
