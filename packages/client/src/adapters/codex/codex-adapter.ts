import { randomBytes } from 'node:crypto';
import { execFile, type spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import type {
  AgentEvent,
  PermissionMode,
  TaskOfferPayload,
} from '@byok-sdk/protocol';
import {
  freezeRuntimeAdapterDescriptor,
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeDetectResult,
  type RuntimeAdapterPrepareInput,
  type RuntimeAdapterPrepareResult,
  type RuntimeOperationStartInput,
  type Session,
} from '../../types';
import {
  RuntimeExecutionFailure,
  RuntimeStartupDisposalFailure,
  isRuntimeExecutionFailure,
} from '../../runtime-failure';
import {
  resolveSdkReservedHelperBin,
  type SdkHelperHostConfig,
} from '../../sdk-reserved-helper-host';
import {
  wrapMcpServerWithLaunchCwd,
  type McpLaunchBinding,
} from '../../daemon/trusted-launch-cwd';
import {
  grantFingerprint,
  resolveMcpToolsetGrants,
  resolveReservedMcpToolGrants,
  type McpToolsetGrant,
} from '../mcp-tool-grants';
import { classifyDetectError, probeRuntimeVersion } from '../detect-outcome';
import { createOwnedLineProcessSpawn } from '../../runtime/owned-line-process';
import {
  codexSession,
  type RawCodexSession,
} from '../../runtime/codex-session-runtime';
import { CodexProjection, type CodexRecord } from './projection';
import { AsyncQueue } from '../../util/async-queue';
import { resolveCodexBin, type ResolvedBin } from './resolve-bin';
import { mapPermissionPolicyToCodexArgs } from './permission-mapping';
import { withoutProviderCredentials } from '../provider-credential-environment';

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5000;
const RESERVED_MCP_POLICY_PROBE_TIMEOUT_MS = 5000;
const PINNED_CODEX_VERSION = '0.159.2';
export interface CodexAdapterOptions {
  sdkHelperHost?: SdkHelperHostConfig;
  resolveBin?: () => ResolvedBin;
  spawnFn?: typeof nodeSpawn;
  maxRetainedBytes?: number;
  interruptTimeoutMs?: number;
}

/** Codex app-server is experimental. Only the qualified 0.159.2 binary is admitted; no exec compatibility path. */
export class CodexAdapter implements RuntimeAdapter {
  readonly descriptor = freezeRuntimeAdapterDescriptor({
    id: 'codex',
    supportsDispatchSelection: true,
    requiresMcpToolsetToolObservation: true,
    mcpServerLaunch: 'launcher-wrapped',
    capabilities: {
      steer: true,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
      permissionModes: ['auto'],
    },
    environmentRequirements: { credentialNames: [] },
  });
  constructor(private readonly options: CodexAdapterOptions = {}) {
    if (
      !Number.isSafeInteger(options.maxRetainedBytes ?? 16 * 1024 * 1024) ||
      (options.maxRetainedBytes ?? 16 * 1024 * 1024) < 1
    )
      throw new TypeError('invalid Codex retention budget');
    if (
      !Number.isFinite(options.interruptTimeoutMs ?? 1000) ||
      (options.interruptTimeoutMs ?? 1000) <= 0 ||
      (options.interruptTimeoutMs ?? 1000) > 2_147_483_647
    )
      throw new TypeError('invalid Codex interrupt timeout');
  }
  async detect(): Promise<RuntimeDetectResult> {
    try {
      const command = (this.options.resolveBin ?? resolveCodexBin)().command;
      const version = await probeRuntimeVersion(command, DETECT_TIMEOUT_MS);
      if (version.kind !== 'available') return version;
      const text = version.stdout.trim() || version.stderr.trim();
      if (text !== `codex-cli ${PINNED_CODEX_VERSION}`)
        return { kind: 'refused', reason: 'runtime_version_unsupported' };
      try {
        await execFileAsync(command, ['app-server', '--help'], {
          timeout: DETECT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        });
      } catch {
        return { kind: 'refused', reason: 'app_server_unavailable' };
      }
      let authPresent = false;
      try {
        const auth = await execFileAsync(command, ['login', 'status'], {
          timeout: DETECT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        });
        authPresent = /logged in (using|with)/i.test(
          auth.stdout + '\n' + auth.stderr,
        );
      } catch {}
      return { kind: 'available', version: text, authPresent };
    } catch (error) {
      return classifyDetectError(error);
    }
  }
  async prepare(
    input: RuntimeAdapterPrepareInput,
  ): Promise<RuntimeAdapterPrepareResult> {
    const policy = mapPermissionPolicyToCodexArgs(input.policy);
    if (!policy.ok)
      return {
        kind: 'reject',
        reason: policy.reason ?? 'unsupported Codex policy',
        retryable: false,
      };
    let model: string | undefined;
    try {
      model = subscriptionModel(input.offer.dispatchSelection);
    } catch (error) {
      return {
        kind: 'reject',
        reason:
          error instanceof Error ? error.message : 'unsupported selection',
        retryable: false,
      };
    }
    const detected = await this.detect();
    if (detected.kind !== 'available')
      return {
        kind: 'reject',
        reason: `codex installation refused: ${detected.kind === 'refused' ? detected.reason : detected.kind}`,
        retryable: false,
      };
    const command = (this.options.resolveBin ?? resolveCodexBin)().command;
    const projected = resolveMcpToolsetGrants(
      input.mcpServers,
      input.mcpToolsetTools,
      input.policy.mode,
    );
    if (!projected.ok)
      return { kind: 'reject', reason: projected.reason, retryable: false };
    const grants = [
      ...resolveReservedMcpToolGrants(input.mcpServers),
      ...projected.grants,
    ];
    try {
      for (const grant of grants)
        await probeCodexMcpToolApproval(
          command,
          grant.server,
          input.mcpServers![grant.server]!,
          grant.tools,
        );
    } catch (error) {
      return {
        kind: 'reject',
        reason: `Codex MCP preflight failed: ${error instanceof Error ? error.message : 'invalid readback'}`,
        retryable: false,
      };
    }
    return {
      kind: 'prepared',
      operation: {
        start: (start) =>
          this.start(
            start,
            command,
            model,
            projected.grants,
            grants,
            input.policy.mode,
          ),
      },
    };
  }
  private async start(
    input: RuntimeOperationStartInput,
    command: string,
    model: string | undefined,
    prepared: readonly McpToolsetGrant[],
    grants: readonly McpToolsetGrant[],
    mode: PermissionMode,
  ): Promise<Session> {
    const actual = resolveMcpToolsetGrants(
      input.mcpServers,
      input.mcpToolsetTools,
      mode,
    );
    if (
      !actual.ok ||
      grantFingerprint(actual.grants) !== grantFingerprint(prepared)
    )
      throw authority(
        'prepared codex operation received different MCP toolset tool authority',
      );
    if (input.kind !== 'instruction' || typeof input.instruction !== 'string')
      throw authority('codex requires a resolved instruction');
    if (subscriptionModel(input.manifest.dispatchSelection) !== model)
      throw authority(
        'prepared codex operation received a manifest with different runtime selection',
      );
    const cwd = input.manifest.cwd;
    if (!cwd) throw authority('codex manifest has no sealed cwd');
    const workspace = await fs.realpath(cwd);
    // Operator allow cannot opt this subscription runtime into env credentials.
    // Strip before adding the task-owned MCP transport payloads, never ambient env.
    const env = withoutProviderCredentials(input.env);
    const configArgs = codexMcpConfigArgs(
      input.mcpServers,
      env,
      this.options.sdkHelperHost,
      grants,
      input.mcpLaunch,
    );
    const spawned = createOwnedLineProcessSpawn({
      spawnFn: this.options.spawnFn,
    });
    const session = new CodexSession(
      workspace,
      model,
      this.options.interruptTimeoutMs ?? 1000,
      input.manifest.sessionRef === undefined,
    );
    try {
      const raw = await codexSession(
        (bin, args, options) => {
          const child = spawned(bin, [...args, ...configArgs], options);
          session.own(child);
          void child.exited.then(
            () => session.exited(),
            (error) => session.fail(error),
          );
          return child;
        },
        { kind: 'available', via: 'executable', command },
        {
          cwd,
          env: env as Record<string, string>,
          ...(model === undefined ? {} : { model }),
          ...(input.manifest.sessionRef === undefined
            ? {}
            : { resume: input.manifest.sessionRef }),
        },
        1000,
        {
          maxBytes: this.options.maxRetainedBytes ?? 16 * 1024 * 1024,
          onReady: (id) => session.ready(id),
          onRecord: (record) => session.record(record),
          onLimit: () => {
            const error = infrastructure(
              'codex retained record byte budget exceeded',
            );
            session.fail(error);
            throw error;
          },
        },
      );
      session.bind(raw);
      if (
        input.manifest.sessionRef !== undefined &&
        raw.id !== input.manifest.sessionRef
      )
        throw authority('codex resume returned a different thread id');
      if (input.signal?.aborted)
        throw infrastructure('codex start was aborted');
      await session.prompt(input.instruction);
      return session;
    } catch (error) {
      try {
        await session.close();
      } catch (disposal) {
        throw new RuntimeStartupDisposalFailure(() => session.close(), {
          cause: disposal,
        });
      }
      throw new RuntimeExecutionFailure({
        phase: 'start',
        category: isRuntimeExecutionFailure(error)
          ? error.category
          : 'infrastructure',
        retry: isRuntimeExecutionFailure(error) ? error.retry : 'retryable',
        reason: error instanceof Error ? error.message : 'codex open failed',
      });
    }
  }
}
const authority = (reason: string) =>
  new RuntimeExecutionFailure({
    phase: 'start',
    category: 'authority',
    retry: 'non-retryable',
    reason,
  });
const infrastructure = (reason: string) =>
  new RuntimeExecutionFailure({
    phase: 'run',
    category: 'infrastructure',
    retry: 'non-retryable',
    reason,
  });
class CodexSession implements Session {
  sessionRef = '';
  private raw?: RawCodexSession;
  private child?: { dispose(): Promise<void>; kill(): void };
  private projection?: CodexProjection;
  private readonly stream = {};
  private readonly queue = new AsyncQueue<AgentEvent>();
  private failure?: RuntimeExecutionFailure;
  private active = false;
  private readonly interruptWaiters = new Set<() => void>();
  private stopping = false;
  private closeAttempt?: Promise<void>;
  constructor(
    private readonly workspace: string,
    private readonly model: string | undefined,
    private readonly interruptMs: number,
    private readonly fresh: boolean,
  ) {}
  own(child: { dispose(): Promise<void>; kill(): void }): void {
    this.child = child;
  }
  ready(id: string): void {
    this.sessionRef = id;
    this.projection = new CodexProjection(this.workspace, id, this.fresh);
  }
  bind(raw: RawCodexSession): void {
    this.raw = raw;
  }
  record(record: CodexRecord): void {
    try {
      this.projection?.consume(this.stream, record, (event) =>
        this.queue.push(event),
      );
      const body = record.body as {
        origin?: string;
        type?: string;
        native?: {
          threadId?: string;
          turn?: { status?: string; error?: { message?: string } };
        };
      };
      if (
        record.kind === 'frame' &&
        body.origin === 'byok-native' &&
        body.type === 'turn/completed' &&
        (body.native?.threadId === undefined ||
          body.native.threadId === this.sessionRef)
      ) {
        this.active = false;
        for (const resolve of this.interruptWaiters) resolve();
        if (body.native?.turn?.status === 'failed')
          this.fail(
            new RuntimeExecutionFailure({
              phase: 'run',
              category: 'semantic',
              retry: 'non-retryable',
              reason: body.native.turn.error?.message ?? 'codex turn failed',
            }),
          );
      }
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  fail(error: unknown): void {
    this.failure ??= isRuntimeExecutionFailure(error)
      ? error
      : infrastructure(
          error instanceof Error ? error.message : 'codex runtime failed',
        );
    this.flushPendingUsage();
    this.queue.end();
    void this.close().catch(() => {});
  }
  exited(): void {
    if (!this.stopping) this.fail(infrastructure('codex app-server exited'));
  }
  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return (async function* () {
      try {
        for await (const event of self.queue) yield event;
      } catch (error) {
        self.fail(error);
        throw self.failure;
      }
      if (self.failure) throw self.failure;
    })();
  }
  async prompt(input: string): Promise<void> {
    if (!this.raw) throw infrastructure('codex session is not open');
    this.active = true;
    const result = await this.raw.prompt(input);
    if (result.response.body.kind !== 'accepted') {
      this.active = false;
      throw infrastructure(
        result.response.body.reason ?? 'codex prompt refused',
      );
    }
  }
  async followUp(task: TaskOfferPayload): Promise<void> {
    if (typeof task.instruction !== 'string')
      throw new PolicyUnsupportedError('codex requires a string instruction');
    if (!mapPermissionPolicyToCodexArgs(task.policy ?? { mode: 'auto' }).ok)
      throw new PolicyUnsupportedError('unsupported Codex policy');
    const model = subscriptionModel(task.dispatchSelection);
    if (model !== undefined && model !== this.model)
      throw new PolicyUnsupportedError(
        'codex persistent session cannot change model',
      );
    await this.prompt(task.instruction);
  }
  async steer(text: string): Promise<void> {
    const result = await this.raw?.steer(text);
    if (result?.response.body.kind !== 'accepted')
      throw infrastructure(
        result?.response.body.reason ?? 'codex steer refused',
      );
  }
  async interrupt(): Promise<void> {
    if (!this.raw || !this.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveTurn!: () => void;
    const turnSettled = new Promise<void>(resolve => { resolveTurn = resolve; });
    this.interruptWaiters.add(resolveTurn);
    try {
      await Promise.race([
        this.raw.abort().then(async result => {
          // turn/interrupt ACK accepts the command; turn/completed carries
          // final usage/outcome. Closing at ACK discards those native frames.
          if (result.response.body.kind === 'accepted') await turnSettled;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(infrastructure('codex late interrupt timed out')),
            this.interruptMs,
          );
        }),
      ]);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
      this.interruptWaiters.delete(resolveTurn);
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    if (!this.closeAttempt) {
      const promise = Promise.resolve().then(async () => {
        try {
          try {
            await this.raw?.dispose();
          } catch (error) {
            if (!this.failure) throw error;
          } finally {
            await this.child?.dispose();
          }
        } finally {
          // Stdout may contain final native frames after the interrupt ACK.
          // End the consumer only after disposal has drained that transport.
          this.flushPendingUsage();
          this.queue.end();
        }
        this.raw = undefined;
        this.projection = undefined;
        this.child = undefined;
      });
      this.closeAttempt = promise.catch((error) => {
        this.closeAttempt = undefined;
        throw error;
      });
    }
    await this.closeAttempt;
  }
  private flushPendingUsage(): void {
    const usage = this.projection?.takePendingUsage(this.stream);
    if (usage) this.queue.push(usage);
  }
  async resolveApproval(): Promise<void> {
    throw new PolicyUnsupportedError(
      'Codex has no interactive approval product lane',
    );
  }
}
function subscriptionModel(
  selection: TaskOfferPayload['dispatchSelection'],
): string | undefined {
  if (!selection) return undefined;
  if (selection.lane !== 'subscription' || selection.runtimeId !== 'codex')
    throw new PolicyUnsupportedError(
      'codex cannot execute this runtime selection',
    );
  return selection.modelId;
}

async function probeCodexMcpToolApproval(
  command: string,
  name: string,
  server: NonNullable<RuntimeAdapterPrepareInput['mcpServers']>[string],
  tools: readonly string[],
): Promise<void> {
  // Qualified app-server 0.159.2 does not accept the old exec ignore-user-config flag.
  // Pin the named server's exact enabled_tools and per-tool settings and read back only that grant.
  const probeArgs = [
    'mcp',
    'get',
    name,
    '--json',
    '-c',
    `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
    ...codexMcpToolApprovalArgs(name, tools),
  ];
  const result = await execFileAsync(command, probeArgs, {
    timeout: RESERVED_MCP_POLICY_PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const parsed = JSON.parse(result.stdout) as {
    name?: unknown;
    enabled?: unknown;
    enabled_tools?: unknown;
  };
  const readBack = Array.isArray(parsed.enabled_tools)
    ? parsed.enabled_tools
    : undefined;
  if (
    parsed.name !== name ||
    parsed.enabled !== true ||
    readBack === undefined ||
    readBack.length !== tools.length ||
    readBack.some((tool, index) => tool !== tools[index])
  ) {
    throw new Error(
      `Codex did not read back the exact tool allowlist for MCP server "${name}"`,
    );
  }
}

/** The one-server grant pair: an exact tool allowlist, and per-tool approval for exactly those tools. */
function codexMcpToolApprovalArgs(
  name: string,
  tools: readonly string[],
): string[] {
  const args = [
    '-c',
    `mcp_servers.${name}.enabled_tools=${JSON.stringify([...tools])}`,
  ];
  for (const tool of tools) {
    args.push(
      '-c',
      `mcp_servers.${name}.tools.${tool}.approval_mode="approve"`,
    );
  }
  return args;
}

function codexMcpConfigArgs(
  servers: RuntimeOperationStartInput['mcpServers'],
  env: NodeJS.ProcessEnv,
  helperHost: SdkHelperHostConfig | undefined,
  grants: readonly McpToolsetGrant[] = [],
  launch?: McpLaunchBinding,
): string[] {
  if (servers === undefined || Object.keys(servers).length === 0) return [];
  // Codex spawns every server itself from these `-c` overrides, and
  // `mcp_servers.*` has no cwd field — the child would inherit the CLI's cwd,
  // which for an Agent task is the Agent home the agent writes by design, and
  // from which a `bun --compile` server binary runs `bunfig.toml` `preload`
  // before its own code. The `mcp-env` helper that unseals each server's
  // environment is therefore itself launched through this package's
  // `bin/byok-launch-cwd.mjs`, which chdirs into the daemon's
  // proven-non-writable directory before exec'ing it; the real server inherits
  // that directory from the helper. The CLI's own cwd is unchanged.
  if (launch?.launcher === undefined) {
    throw new RuntimeExecutionFailure({
      phase: 'start',
      category: 'authority',
      retry: 'non-retryable',
      reason:
        'prepared codex operation received MCP servers without a trusted launch directory',
    });
  }
  const launchBinding = { cwd: launch.cwd, launcher: launch.launcher };
  const grantedTools = new Map(
    grants.map((grant) => [grant.server, grant.tools] as const),
  );
  const args: string[] = []; // app-server 0.159.2 has no ignore-user-config flag.
  for (const [name, server] of Object.entries(servers).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const key = `BYOK_MCP_PAYLOAD_${randomBytes(16).toString('hex').toUpperCase()}`;
    env[key] = JSON.stringify(server);
    let helper;
    try {
      helper = wrapMcpServerWithLaunchCwd(
        resolveSdkReservedHelperBin('mcp-env', helperHost),
        launchBinding,
      );
    } catch (cause) {
      // Same reason as the claude adapter: a `launch_cwd_*` refusal is this
      // adapter's own pre-spawn refusal and must arrive typed, or TaskRunner
      // projects it as a generic `runtime adapter contract violation during
      // start` and the operator never sees which rule refused.
      throw new RuntimeExecutionFailure(
        {
          phase: 'start',
          category: 'authority',
          retry: 'non-retryable',
          reason: `prepared codex operation cannot launch an MCP server in the trusted launch directory: ${cause instanceof Error ? cause.message : 'launch_cwd_target_refused'}`,
        },
        { cause },
      );
    }
    args.push(
      '-c',
      `mcp_servers.${name}.command=${JSON.stringify(helper.command)}`,
    );
    args.push(
      '-c',
      `mcp_servers.${name}.args=${JSON.stringify([...(helper.args ?? [])])}`,
    );
    args.push(
      '-c',
      `mcp_servers.${name}.env.BYOK_MCP_ENV_KEY=${JSON.stringify(key)}`,
    );
    args.push('-c', `mcp_servers.${name}.env_vars=${JSON.stringify([key])}`);
    const granted = grantedTools.get(name);
    if (granted !== undefined)
      args.push(...codexMcpToolApprovalArgs(name, granted));
  }
  return args;
}
