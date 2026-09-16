import { serializePiHostConfig } from './runtime-host-binding';
import { parsePiMcpEnvironment } from './mcp-environment';
import { assertImplementationSpawnBinding } from '@byok-sdk/implementation-identity';
import { resolvePiRuntimeLaunch, type PiRuntimeLaunchResources } from './runtime-launch';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path, { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentEvent,
  PermissionPolicy,
  ProviderProfileBinding,
  TaskOfferPayload,
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
} from '../../types';
import {
  inputPreparationDigest,
  INPUT_PREPARATION_ARTIFACT_FORMAT,
  INPUT_PREPARATION_VERSION,
} from '../../input-preparation';
import { mcpLaunchAttestation, type McpLaunchBinding } from '../../daemon/trusted-launch-cwd';
import type { ToolImplementationIdentityV1 } from '../../daemon/tool-implementation-identity';
import { RuntimeDisposalFailure, RuntimeExecutionFailure, isRuntimeExecutionFailure } from '../../runtime-failure';
import { grantFingerprint, resolveMcpToolsetGrants } from '../mcp-tool-grants';
import { clientPackageRoot } from './client-manifest';
import { resolvePiBin, type ResolvedBin } from './resolve-bin';
import { mapPermissionPolicyToPiArgs } from './permission-mapping';
import { mapPiMessageToAgentEvent, ROUTINE_PI_EVENT_TYPES } from './events';
import { PiRpcClient, type PiRpcMessage, type SpawnFn } from './rpc-client';
import { buildPreparedPromptCommand, PREPARED_PROMPT_COMMAND_ID } from './prepared-prompt-frame';
import {
  PROVIDER_CREDENTIAL_ENV_NAMES,
  withoutProviderCredentials,
} from '../provider-credential-environment';

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5_000;

/** Package scripts require an interpreter; explicit executable overrides do not. */
function piInvocation(bin: ResolvedBin): { command: string; entry?: string } {
  return bin.source === 'package'
    ? { command: process.execPath, entry: bin.command }
    : { command: bin.command };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Task-owned cleanup is part of the close receipt and must fail visibly. */
async function cleanupMcpConfigDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (cause) {
    throw new RuntimeDisposalFailure({
      stage: 'cleanup',
      reason: 'pi task-scoped MCP configuration could not be removed',
    }, { cause });
  }
}

/**
 * Known provider credential env var *names* (never values) — see the
 * credential-isolation rule on `RuntimeAdapter`. `detect()` only checks
 * whether one of these names is set; it never reads pi's own auth storage
 * (`~/.pi/...`) or any file contents. Not exhaustive (pi supports ~30
 * providers); covers the common ones for a useful `authPresent` signal.
 */
export interface PiAdapterOptions {
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
    '--launch-binding',
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
    // authority on what a toolset contains.
    requiresMcpToolsetToolObservation: true,
    mcpServerLaunch: 'direct-cwd',
    capabilities: {
      steer: true,
      resume: true,
      mcpToolsets: true,
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly'],
    },
    environmentRequirements: { credentialNames: PROVIDER_CREDENTIAL_ENV_NAMES },
  });

  constructor(private readonly options: PiAdapterOptions = {}) {
    validatePiByokLauncherConfig(options.byokLauncher);
  }

  async detect(): Promise<RuntimeDetectResult> {
    try {
      const bin = this.resolveBin();
      const invocation = piInvocation(bin);
      const probe = await probeRuntimeVersion(invocation.command, DETECT_TIMEOUT_MS,
        invocation.entry === undefined ? [] : [invocation.entry]);
      if (probe.kind !== 'available') return probe;
      const version = probe.stdout.trim() || probe.stderr.trim();
      const authPresent = PROVIDER_CREDENTIAL_ENV_NAMES.some((name) => process.env[name] !== undefined);
      return { kind: 'available', version, authPresent };
    } catch (error) {
      return classifyDetectError(error);
    }
  }

  async prepare(input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> {
    // The policy mapping runs FIRST: a mode pi cannot express at all is a
    // refusal about the mode, and resolving toolset grants before it would
    // answer that task with a toolset-shaped reason instead.
    const mapping = mapPermissionPolicyToPiArgs(input.policy);
    if (!mapping.ok) {
      return { kind: 'reject', reason: mapping.reason ?? 'policy rejected by pi adapter', retryable: false };
    }
    // Fail closed BEFORE anything is spawned, on the same resolution claude
    // and codex use. pi does not interpolate these names into a CLI grant —
    // it registers one tool per observed tool — but it reads exactly the same
    // authority: `./mcp-extension.ts` refuses at extension load when a
    // projected server has no daemon observation, and `../../mcp/projection.ts`
    // refuses a server name outside `GRANTABLE_MCP_SERVER_NAME`. Discovering
    // that inside the Pi child means a claimed task dying at session start
    // with a message only the child's stderr carries, so the check runs here
    // instead, and declines non-retryably like its siblings.
    // Per-tool registration also makes the task's permission mode decidable
    // per tool: the same resolution applies the operator's
    // `McpToolsetConfig.readOnlyTools` classification, so a task under a
    // narrowing mode is admitted with exactly the read-only tools the device
    // declared, and an unclassified toolset is refused by name here rather
    // than running with everything enabled.
    const toolsetGrants = resolveMcpToolsetGrants(input.mcpServers, input.mcpToolsetTools, input.policy.mode);
    if (!toolsetGrants.ok) {
      return {
        kind: 'reject',
        reason: `pi adapter cannot register projected MCP toolset tools: ${toolsetGrants.reason}`,
        retryable: false,
      };
    }

    // Inline factories are owned by the SDK entry; no runtime extension path resolution here.
    // Session/workspace continuity:
    // `task.sessionRef` is only ever non-empty here when `task-runner.ts`
    // has (a) found a recorded workspace for this exact sessionRef in its
    // `SessionWorkspaceStore` and (b) spawned this adapter with
    // `ctx.workspaceDir` set to that SAME directory — see task-runner.ts's
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
    // resume it. `TaskOfferPayload.workspaceHint` remains unimplemented (no
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
    const pinnedSelection: TaskOfferPayload['dispatchSelection'] = selection === undefined
      ? undefined
      : selection.lane === 'byok-profile'
        ? Object.freeze({
            ...selection,
            providerProfile: Object.freeze({
              ...selection.providerProfile,
              requiredCapabilities: Object.freeze([...selection.providerProfile.requiredCapabilities]),
            }),
          }) as unknown as TaskOfferPayload['dispatchSelection']
        : Object.freeze({ ...selection }) as TaskOfferPayload['dispatchSelection'];
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
    return {
      kind: 'prepared',
      operation: {
        resolveRuntimeLaunch: async (resources) => {
          if (boundRuntime !== undefined) throw authorityFailure('runtime launch resources were already resolved');
          const kind = resources.kind === 'prepared' ? 'pi-prepared' : 'pi-rpc';
          boundRuntime = await resolvePiRuntimeLaunch({
            ...resources, sessionCwd: resources.cwd, kind,
            env: pinnedSelection === undefined ? resources.env : withoutProviderCredentials(resources.env),
            resolveDevInvocation: () => {
              // Validate the installed native package before choosing the SDK
              // entry. Configured authority lanes never reach this dev resolver.
              const bin = this.resolveBin();
              if (kind === 'pi-prepared') return { command: process.execPath, entry: preparedPiLaunchBin() };
              return this.options.resolveBin === undefined
                ? { command: process.execPath, entry: path.join(clientPackageRoot(), 'dist', 'bin', 'byok-pi-rpc.js') }
                : piInvocation(bin);
            },
            ...(kind === 'pi-rpc' && pinnedSelection !== undefined
              ? { keysSessionDir: this.options.byokLauncher!.sessionDir } : {}),
          });
          return boundRuntime;
        },
        start: async (startInput: RuntimeOperationStartInput): Promise<Session> => {
          const runtimeLaunch = startInput.runtimeLaunch;
          if (runtimeLaunch === undefined || runtimeLaunch !== boundRuntime) throw authorityFailure('Pi start requires its resolved runtime launch binding');
          if (runtimeLaunch.kind !== (startInput.kind === 'prepared' ? 'pi-prepared' : 'pi-rpc')) throw authorityFailure('Pi start lane differs from runtime launch binding');
          if (runtimeLaunch.sessionCwd !== startInput.manifest.cwd) throw authorityFailure('Pi runtime session cwd differs from manifest');
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
          // The toolset grant this operation was ADMITTED with was resolved
          // from the prepare() input; the resources handed to start() are a
          // separate object. pi does not bake the grant into a CLI argument —
          // it writes the servers plus the daemon's observation into the
          // task-scoped MCP config the extension registers from — so without
          // this comparison a caller could swap in different MCP authority
          // (or a different tool observation) between admission and start and
          // the child would register the swapped set. Same fail-closed
          // re-check `claude-adapter.ts` makes, on the same fingerprint, and
          // it runs BEFORE the task config is written so nothing of the
          // swapped authority ever reaches disk.
          const startGrants = resolveMcpToolsetGrants(startInput.mcpServers, startInput.mcpToolsetTools, input.policy.mode);
          if (!startGrants.ok || grantFingerprint(startGrants.grants) !== grantFingerprint(toolsetGrants.grants)) {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation received different MCP toolset tool authority than it was admitted with',
            });
          }
          // The prepared lane diverges here, AFTER every authority check both
          // lanes share: the same sealed selection, the same sealed cwd and the
          // same MCP grant fingerprint. What it does not share is the CLI —
          // `pi --mode rpc` can never consume a prepared request, so this branch
          // launches the SDK-owned in-process host instead
          // (`../../bin/byok-pi-prepared.ts`).
          if (startInput.kind === 'prepared') {
            return await startPreparedPiOperation({
              runtimeLaunch,
              mcpEnv,
              preparation: startInput.preparation,
              policy: input.policy,
              manifest: startInput.manifest,
              manifestCwd,
              manifestSelection,
              env: startInput.env,
              ...(startInput.mcpServers === undefined ? {} : { mcpServers: startInput.mcpServers }),
              ...(startInput.mcpToolsetTools === undefined ? {} : { mcpToolsetTools: startInput.mcpToolsetTools }),
              ...(startInput.mcpLaunch === undefined ? {} : { mcpLaunch: startInput.mcpLaunch }),
              ...(startInput.mcpToolImplementations === undefined
                ? {}
                : { mcpToolImplementations: startInput.mcpToolImplementations }),
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
          let mcpConfigDir: string | undefined;
          let runtimeEnv = { ...runtimeLaunch.env };
          const taskMcpServers = startInput.mcpServers ?? {};
          // The daemon resolved ONE proven-non-writable launch directory for
          // this task (`daemon/trusted-launch-cwd.ts`) and probed every server
          // in it. pi's own extension opens the servers, so the directory
          // travels in the task-scoped config and is passed straight to
          // `spawn` — no launcher, because this adapter owns the spawn.
          //
          // Fail closed rather than omit it: an MCP server started without it
          // would inherit the Pi process directory instead of consuming the
          // independently admitted MCP launch binding.
          const mcpLaunchCwd = startInput.mcpLaunch?.cwd;
          if (Object.keys(taskMcpServers).length > 0 && mcpLaunchCwd === undefined) {
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'prepared pi operation received MCP servers without a trusted launch directory',
            });
          }
          let mcpConfigPath: string;
          let hostConfigDigest: string;
          let hostConfigPath: string;
          try {
            mcpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-mcp-'));
            await fs.chmod(mcpConfigDir, 0o700).catch(() => {});
            mcpConfigPath = path.join(mcpConfigDir, 'mcp-config.json');
            // The daemon's observation travels WITH the servers: the extension
            // registers exactly the tools named here and discovers nothing of
            // its own, so the tools the model is shown are the tools this task
            // was admitted with.
            //
            // The FULL observation is written, classification included, and
            // the task's permission mode alongside it. The extension needs
            // both: it registers only the tools the mode allows (running the
            // same `filterMcpObservationForPolicy` this adapter just ran), but
            // it verifies a connected server against everything written here,
            // so a frozen list already narrowed by policy would read every
            // excluded tool back as a newly added one.
            //
            // What is written is the START observation, so the prepare->start
            // window is deliberately unfingerprinted for the tools a narrowing
            // mode excludes: those tools are unreachable in this session, so a
            // mutation tool appearing in that window changes nothing the model
            // can call. Everything that IS reachable still trips the
            // fingerprint compared above — a read-only tool added, removed, or
            // reclassified between prepare and start changes the grant set and
            // the operation is refused.
            await fs.writeFile(
              mcpConfigPath,
              JSON.stringify({
                mcpEnv,
                mcpServers: taskMcpServers,
                observation: startInput.mcpToolsetTools ?? {},
                permissionMode: input.policy.mode,
                ...(mcpLaunchCwd === undefined ? {} : { launchCwd: mcpLaunchCwd }),
                // The daemon resolved these once, at admission, alongside the
                // launch directory (`daemon/tool-implementation-identity.ts`).
                // The extension opens the servers in this child, so the
                // identities travel here and are re-measured there before each
                // spawn. This adapter resolves nothing of its own: a second
                // resolve would be a second opinion about the same install.
                ...(startInput.mcpToolImplementations === undefined
                  ? {}
                  : { toolImplementations: startInput.mcpToolImplementations }),
              }),
              { mode: 0o600 },
            );
            hostConfigPath = path.join(mcpConfigDir!, 'rpc-launch.json');
            const serialized = serializePiHostConfig({
              binding: runtimeLaunch.binding, descendantPlan: runtimeLaunch.descendantPlan,
              format: 'byok.pi.rpc-launch', version: 2, cwd: runtimeLaunch.sessionCwd,
              mcp: JSON.parse(await fs.readFile(mcpConfigPath, 'utf8')), policy: input.policy,
            });
            hostConfigDigest = serialized.digest;
            await fs.writeFile(hostConfigPath, serialized.bytes, { mode: 0o600 });
          } catch (cause) {
            await cleanupMcpConfigDir(mcpConfigDir);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'infrastructure', retry: 'retryable',
              reason: 'pi task-scoped MCP configuration could not be created',
            }, { cause });
          }
          const piArgs = ['--config', hostConfigPath, '--mode', 'rpc', '--no-skills',
            ...(resumeSessionId === undefined ? [] : ['--session', resumeSessionId]), ...mapping.args];
          const launch = runtimeLaunch.binding;
          const targetArgs = [...(launch.entry === undefined ? [] : [launch.entry]), ...launch.fixedArgv, `--config-digest=${hostConfigDigest}`, ...piArgs];
          let launchCommand = launch.command;
          let launchArgs = targetArgs;
          if (launcherArgs !== undefined) {
            launchCommand = this.options.byokLauncher!.command;
            launchArgs = [...(this.options.byokLauncher!.args ?? []), '--pi-bin', launch.command, ...launcherArgs,
              ...(launch.entry === undefined ? [] : ['--pi-entry', launch.entry]),
              '--pi-cwd', launch.cwd, '--pi-fixed-args', JSON.stringify(launch.fixedArgv),
              '--launch-binding', JSON.stringify(launch), '--pi-config-digest', hostConfigDigest, '--', ...piArgs];
          }
          let rpc: PiRpcClient;
          try {
            await reverifyPiRuntimeLaunch(runtimeLaunch);
            rpc = new PiRpcClient({
              command: launchCommand,
              args: launchArgs,
              cwd: launch.cwd,
              env: runtimeEnv,
              spawnFn: this.options.spawnFn,
            });
          } catch (cause) {
            await cleanupMcpConfigDir(mcpConfigDir);
            if (cause instanceof RuntimeExecutionFailure) throw cause;
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'infrastructure', retry: 'retryable',
              reason: 'pi runtime process could not be spawned',
            }, { cause });
          }

          let response: PiRpcMessage;
          try {
            response = await rpc.send({ type: 'prompt', message: startInput.instruction });
          } catch (cause) {
            rpc.kill();
            await cleanupMcpConfigDir(mcpConfigDir);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'infrastructure', retry: 'retryable',
              reason: `pi initial prompt transport failed: ${errorMessage(cause)}`,
            }, { cause });
          }
          if (response.success === false) {
            rpc.kill();
            await cleanupMcpConfigDir(mcpConfigDir);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'semantic', retry: 'non-retryable',
              reason: typeof response.error === 'string' ? response.error : 'pi rejected the initial prompt',
            });
          }

          let sessionRef: string;
          try {
            sessionRef = await resolveAuthoritativeSessionId(rpc);
          } catch (err) {
            rpc.kill();
            await cleanupMcpConfigDir(mcpConfigDir);
            throw err;
          }
          if (resumeSessionId !== undefined && sessionRef !== resumeSessionId) {
            rpc.kill();
            await cleanupMcpConfigDir(mcpConfigDir);
            throw new RuntimeExecutionFailure({
              phase: 'start', category: 'authority', retry: 'non-retryable',
              reason: 'pi resumed a different authoritative session than requested',
            });
          }
          return new PiSession(sessionRef, rpc, manifestSelection, mcpConfigDir, runtimeLaunch.release);
        },
      },
    };
  }

  private resolveBin(): ResolvedBin {
    return (this.options.resolveBin ?? resolvePiBin)();
  }
}

/**
 * Everything one prepared pi launch needs, after both lanes' shared authority
 * checks have already passed.
 */
interface PreparedPiLaunchInput {
  readonly mcpEnv: Readonly<Record<string, string>>;
  readonly runtimeLaunch: PiRuntimeLaunchResources;
  readonly preparation: RuntimePreparedLaunchV1;
  /** The policy this operation was ADMITTED under, whole. */
  readonly policy: PermissionPolicy;
  readonly manifest: RuntimeOperationManifest;
  readonly manifestCwd: string;
  readonly manifestSelection: TaskOfferPayload['dispatchSelection'];
  readonly env: NodeJS.ProcessEnv;
  readonly mcpServers?: Readonly<Record<string, McpStdioServerConfig>>;
  readonly mcpToolsetTools?: McpToolsetToolObservation;
  readonly mcpLaunch?: McpLaunchBinding;
  readonly mcpToolImplementations?: Readonly<Record<string, ToolImplementationIdentityV1>>;
  readonly spawnFn?: SpawnFn;
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
 *    launch boundary and implementation identities this task resolved must be
 *    the ones the preparation attested. These are the adapter's own fail-closed
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
  if (input.policy.mode !== preparation.permissionMode) {
    throw authorityFailure(
      'prepared pi operation was admitted under a permission mode its counted manifest was not filtered for',
    );
  }
  const mcpLaunch = input.mcpLaunch;
  if (mcpLaunch === undefined) {
    throw authorityFailure('prepared pi operation received no trusted launch directory');
  }
  const launch = mcpLaunchAttestation(mcpLaunch);
  const attested = mcpLaunchAttestation(preparation.launch);
  if (inputPreparationDigest(launch) !== inputPreparationDigest(attested)) {
    throw authorityFailure(
      'prepared pi operation resolved a different MCP launch boundary than the one its preparation attested',
    );
  }
  const toolImplementations = input.mcpToolImplementations ?? {};
  if (inputPreparationDigest(toolImplementations) !== inputPreparationDigest(preparation.toolImplementations)) {
    throw authorityFailure(
      'prepared pi operation resolved different MCP implementation identities than the ones its preparation bound',
    );
  }

  const envelope = await readPreparedArtifact(preparation);

  let configDir: string | undefined;
  let configPath: string;
  let configDigest: string;
  try {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-prepared-'));
    await fs.chmod(configDir, 0o700).catch(() => {});
    configPath = path.join(configDir, 'prepared-launch.json');
    const serialized = serializePiHostConfig({
        binding: input.runtimeLaunch.binding,
        descendantPlan: input.runtimeLaunch.descendantPlan,
        format: 'byok.pi.prepared-launch',
        version: 2,
        cwd: input.manifestCwd,
        policy: input.policy,
        countedPermissionMode: preparation.permissionMode,
        expected: { model: preparation.expected.model },
        toolBindingDigest: preparation.toolBindingDigest,
        observationDigest: preparation.observationDigest,
        toolsetDefinitionRevisions: preparation.toolsetDefinitionRevisions,
        launch,
        // The SAME task-scoped MCP shape the ordinary extension reads, written
        // by the same adapter from the same resources. The prepared host parses
        // it with the same parser and reaches the servers through the same pool.
        mcp: {
          mcpEnv: input.mcpEnv,
          mcpServers: input.mcpServers ?? {},
          observation: input.mcpToolsetTools ?? {},
          permissionMode: preparation.permissionMode,
          launchCwd: mcpLaunch.cwd,
          toolImplementations,
        },
      });
    configDigest = serialized.digest;
    await fs.writeFile(configPath, serialized.bytes, { mode: 0o600 });
  } catch (cause) {
    await cleanupMcpConfigDir(configDir);
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'infrastructure', retry: 'retryable',
      reason: 'pi prepared launch configuration could not be created',
    }, { cause });
  }

  let rpc: PiRpcClient;
  try {
    const binding = input.runtimeLaunch.binding;
    const env = input.runtimeLaunch.env;
    await reverifyPiRuntimeLaunch(input.runtimeLaunch);
    rpc = new PiRpcClient({
      command: binding.command,
      args: [...(binding.entry === undefined ? [] : [binding.entry]), ...binding.fixedArgv, `--config-digest=${configDigest}`, '--config', configPath],
      cwd: binding.cwd,
      // Prepared retains its existing Pi auth-store credential source.
      env,
      ...(input.spawnFn === undefined ? {} : { spawnFn: input.spawnFn }),
    });
  } catch (cause) {
    await cleanupMcpConfigDir(configDir);
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
    rpc.kill();
    await cleanupMcpConfigDir(configDir);
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'infrastructure', retry: 'retryable',
      reason: `pi prepared request transport failed: ${errorMessage(cause)}`,
    }, { cause });
  }
  if (response.success === false) {
    rpc.kill();
    await cleanupMcpConfigDir(configDir);
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
    rpc.kill();
    await cleanupMcpConfigDir(configDir);
    throw authorityFailure('pi admitted the prepared request without reporting an authoritative session id');
  }
  if (data.preparedDigest !== preparation.expected.envelopeDigest) {
    rpc.kill();
    await cleanupMcpConfigDir(configDir);
    throw authorityFailure('pi admitted a prepared request whose digest is not the one this operation counted');
  }
  const sessionRef = data.sessionId;

  let state: PiRpcMessage;
  try {
    state = await rpc.send({ type: 'get_state' });
  } catch (cause) {
    rpc.kill();
    await cleanupMcpConfigDir(configDir);
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'infrastructure', retry: 'retryable',
      reason: `pi transport ended before confirming the prepared session id: ${errorMessage(cause)}`,
    }, { cause });
  }
  const stateData = state.data as { sessionId?: unknown } | undefined;
  if (state.success === false || stateData?.sessionId !== sessionRef) {
    rpc.kill();
    await cleanupMcpConfigDir(configDir);
    throw authorityFailure('pi reported a different session id than the one that admitted the prepared request');
  }

  return new PiSession(sessionRef, rpc, input.manifestSelection, configDir, input.runtimeLaunch.release);
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
  left: TaskOfferPayload['dispatchSelection'],
  right: TaskOfferPayload['dispatchSelection'],
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
 * any prompt is sent, with `messageCount: 0`), so this is safe to call
 * right after the initial prompt is accepted.
 *
 * Finding F8 (fabricated sessionRef): this used to fall back to
 * `crypto.randomUUID()` whenever `get_state` failed, timed out, or omitted
 * `sessionId` — minting an id pi itself never knew about, which could never
 * actually be resumed and silently looked like a legitimate, resumable
 * session to every caller (`TaskRunner`'s `SessionWorkspaceStore`, a future
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
  private closeAttempt: Promise<void> | undefined;

  constructor(
    public readonly sessionRef: string,
    private readonly rpc: PiRpcClient,
    private readonly selection: TaskOfferPayload['dispatchSelection'],
    /** Task-scoped isolated MCP extension configuration, removed in close(). */
    private readonly mcpConfigDir?: string,
    private readonly releaseRuntime?: () => Promise<void>,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const rpc = this.rpc;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        const inner = rpc.events[Symbol.asyncIterator]();
        let terminalFailure: RuntimeExecutionFailure | undefined;
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            for (;;) {
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
                }, { cause: rpc.terminalError });
              }
              const mapped = mapPiMessageToAgentEvent(value);
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

  async followUp(task: TaskOfferPayload): Promise<void> {
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
    await this.rpc.send({ type: 'abort' });
  }

  async close(): Promise<void> {
    if (!this.closeAttempt) {
      const attempt = (async () => {
        await this.rpc.dispose();
        await cleanupMcpConfigDir(this.mcpConfigDir);
        await this.releaseRuntime?.();
      })();
      this.closeAttempt = attempt.catch((error: unknown) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }

  async resolveApproval(): Promise<void> {
    // pi has no built-in per-call approval gate (see permission-mapping.ts)
    // and never emits `needs_approval` in M0/M1, so this should be
    // unreachable in practice. Kept as an explicit, descriptive failure
    // rather than a silent no-op so a future caller (or a misbehaving
    // server) gets a clear error instead of a hang.
    throw new Error('pi adapter does not support approval resume: pi never emits needs_approval in M0/M1');
  }
}

/** The two client-owned final spawn sites share the same authority failure mapping. */
async function reverifyPiRuntimeLaunch(resources: PiRuntimeLaunchResources): Promise<void> {
  const binding = resources.binding;
  try {
    await assertImplementationSpawnBinding(binding, {
      command: binding.command, entry: binding.entry, fixedArgv: binding.fixedArgv,
      cwd: binding.cwd, env: resources.env,
    });
  } catch (cause) {
    throw new RuntimeExecutionFailure({
      phase: 'start', category: 'authority', retry: 'non-retryable',
      reason: `Pi runtime launch reverify failed: ${errorMessage(cause)}`,
    }, { cause });
  }
}
