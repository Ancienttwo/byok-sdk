import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  assertToolImplementationBeforeSpawn,
  ToolImplementationReverifyError,
  type ToolImplementationFsProbe,
  type ToolImplementationIdentityV1,
} from '../daemon/tool-implementation-identity';
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  ReadBuffer,
  SdkError,
  SdkErrorCode,
  serializeMessage,
  type CallToolResult,
  type Implementation,
  type JSONRPCMessage,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker';

/**
 * The SDK's single MCP client authority.
 *
 * Every place this package talks MCP goes through here: the daemon's
 * admission observation (`../daemon/mcp-tools-probe.ts`), the Pi ordinary
 * extension (`../adapters/pi/mcp-extension.ts`), and the frozen projection the
 * prepared launch entry consumes. One authority is the point — a second
 * hand-rolled JSON-RPC dialect (or a third-party adapter's) would be a second
 * place for the framing, the bounds and the name rules to diverge.
 *
 * Protocol, framing and request correlation come from
 * `@modelcontextprotocol/client@2.0.0`. Only the process layer is ours, and
 * only because the bounds below cannot be expressed through the package's own
 * `StdioClientTransport`: it exposes a per-frame `maxBufferSize` and the
 * child's stderr, but no hook on stdout, so the total-stdout cap that
 * `mcp-tools-probe.ts` has always enforced would be silently lost. Spawning
 * ourselves also keeps the environment explicit — `StdioClientTransport`
 * falls back to `getDefaultEnvironment()` when `env` is omitted, and this SDK
 * never lets an MCP child inherit the daemon's ambient environment.
 *
 * stdio only. No HTTP, no SSE, no OAuth, no unix socket.
 */

/**
 * Hard cap on the bytes one server may write to stdout across the whole
 * lifetime of an OBSERVATION client, carried over verbatim from the probe this
 * replaces. The observation reads a fixed handshake, so a server still
 * streaming past this is either broken or hostile; either way it must not grow
 * the daemon's heap while an offer waits on admission.
 *
 * Deliberately NOT a default: a long-lived call client legitimately receives
 * more than this across many `tools/call` answers, and a lifetime cap there
 * would fail a healthy session at an arbitrary point. Callers that have a
 * bounded lifecycle opt in; everyone else is bounded per frame instead.
 */
export const MCP_OBSERVATION_MAX_STDOUT_BYTES = 1_048_576;

/**
 * Hard cap on a single JSON-RPC frame, always applied. A server that never
 * emits a newline cannot make the client accumulate without limit: the read
 * buffer rejects at this size and the connection fails closed.
 */
export const MCP_MAX_FRAME_BYTES = 1_048_576;

/** Default ceiling for one request/response round trip. */
export const MCP_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** How long a closing child is given to exit on SIGTERM before SIGKILL. */
const CHILD_TERMINATION_GRACE_MS = 2_000;

/**
 * SDK error codes that describe the SERVER'S OWN ANSWER rather than its
 * environment. Everything not listed here is treated as environmental and
 * stays retryable.
 */
const AUTHORITY_ERROR_CODES: ReadonlySet<string> = new Set([
  SdkErrorCode.InvalidResult,
  SdkErrorCode.UnsupportedResultType,
  SdkErrorCode.CapabilityNotSupported,
  SdkErrorCode.ListPaginationExceeded,
]);

/**
 * JSON-RPC error codes a server returns that are statements about the REQUEST
 * this client sent, not about the server's condition: the method does not
 * exist, the request is not one this server accepts, the parameters are not
 * ones it accepts, the protocol revision it was sent under is not one the
 * server speaks, or it required a client capability this client does not
 * declare. The same command re-offered later sends the same request — same
 * method, same params, same protocol version, same fixed `CLIENT_INFO` and
 * capability set — and gets the same answer, so these are authority failures.
 *
 * The complete authority set, and nothing else:
 *
 * - `-32601` `MethodNotFound`
 * - `-32600` `InvalidRequest`
 * - `-32602` `InvalidParams`
 * - `-32022` `UnsupportedProtocolVersion` — this client sends one fixed
 *   protocol revision, so a server that rejects it rejects every later offer
 *   identically.
 * - `-32021` `MissingRequiredClientCapability` — the declared capability set
 *   is fixed here too, so a request refused for lacking one stays refused.
 *
 * Every other code — `-32603` `InternalError`, `-32700` `ParseError`,
 * `-32002` `ResourceNotFound`, `-32042` `UrlElicitationRequired`, and any
 * unrecognised code — defaults to retryable. They describe a condition on the
 * server's side, or in the resource it was asked about, rather than a verdict
 * on the request's shape: a handler that threw, a frame it could not read, a
 * server still warming up may legitimately report one once.
 *
 * Retryable here means only "the offer may be made again later". It never
 * means this client replays anything: a `tools/call` is issued exactly once
 * and its failure is returned to the caller as the call's outcome.
 */
const AUTHORITY_PROTOCOL_ERROR_CODES: ReadonlySet<number> = new Set([
  ProtocolErrorCode.MethodNotFound,
  ProtocolErrorCode.InvalidRequest,
  ProtocolErrorCode.InvalidParams,
  ProtocolErrorCode.UnsupportedProtocolVersion,
  ProtocolErrorCode.MissingRequiredClientCapability,
]);

/**
 * The client identity sent in `initialize`. Fixed, not derived from the
 * package version: it is not part of any observation or digest, and a value
 * that moved with every release would churn server-side logs for no gain.
 */
const CLIENT_INFO: Implementation = Object.freeze({
  name: '@byok-sdk/client',
  version: '1',
});

/**
 * A failure caused by the server's own ANSWER rather than by its environment:
 * an ungrantable tool name, a malformed tool entry, an oversized stream, a
 * refused handshake. Retrying cannot change it — the same configured command
 * reports the same thing next time — so callers decline permanently rather
 * than re-offering forever.
 */
export class McpAuthorityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpAuthorityError';
  }
}

/**
 * A failure of the server's ENVIRONMENT rather than its answer: it could not
 * be spawned, it exited before answering, the deadline expired, the pipe
 * broke. These may well succeed later and stay retryable.
 */
export class McpTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpTransportError';
  }
}

/** The exact stdio server this client drives. Command and args only, like the registry. */
export interface McpStdioServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * Layered on top of `env` exactly as the runtime path layers it. Only
   * SDK-reserved servers ever carry one; host toolset configuration rejects
   * the field outright (`../daemon/toolset-registry.ts`).
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpStdioClientOptions {
  /** Prefix on every error message, so a failure names the thing that failed. */
  readonly label?: string;
  /**
   * The exact base environment the RUNTIME child of this task receives
   * (`buildRuntimeEnv`) — never `process.env`. Required, deliberately: a
   * caller that forgets it fails to compile rather than silently reinstating
   * a blanket passthrough of the daemon's own credentials.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Working directory for the child — the same one the runtime CLI is spawned in. */
  readonly cwd?: string;
  /** Per-request deadline. */
  readonly timeoutMs?: number;
  /** Opt-in lifetime stdout cap; see {@link MCP_OBSERVATION_MAX_STDOUT_BYTES}. */
  readonly maxStdoutBytes?: number;
  /**
   * What this SDK has established about the implementation behind the command
   * below (`../daemon/tool-implementation-identity.ts`).
   *
   * Every spawn of an ATTESTED server re-measures it first — see
   * {@link McpStdioClient.connect}. This is the one choke point both spawn
   * points share: the daemon's admission probe and the Pi extension's pool
   * both build their child through this class, so neither can start an
   * attested server that no longer measures the way it was attested.
   *
   * Absent, or `unavailable`, means no claim was made about this server and
   * there is nothing to re-measure. It never means "assume it is fine": the
   * receipt that carried such an identity already says the implementation is
   * unproven.
   */
  readonly implementation?: ToolImplementationIdentityV1;
  /** Test seam, forwarded verbatim; see {@link ToolImplementationFsProbe}. */
  readonly implementationFsProbe?: ToolImplementationFsProbe;
}

/**
 * A `Transport` over one spawned child's stdio, bounded on both axes.
 *
 * Framing, serialization and message validation are the package's
 * (`ReadBuffer` / `serializeMessage`); this adds the process lifecycle and the
 * two byte bounds.
 */
class BoundedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child?: ChildProcessWithoutNullStreams;
  private readonly readBuffer = new ReadBuffer({ maxBufferSize: MCP_MAX_FRAME_BYTES });
  private stdoutBytes = 0;
  private stderrText = '';
  private closed = false;
  private firstFailure?: Error;

  /**
   * The environment this transport will hand to `spawn`, resolved once in the
   * constructor.
   *
   * Read by {@link McpStdioClient.connect}'s implementation gate before the
   * child starts and by {@link start} when it starts it, so the environment
   * that is re-measured is the environment that is spawned rather than a
   * second object built the same way.
   */
  readonly childEnv: Readonly<Record<string, string>>;

  constructor(
    private readonly server: McpStdioServerSpec,
    private readonly options: McpStdioClientOptions,
    private readonly label: string,
  ) {
    this.childEnv = Object.freeze({ ...options.env, ...(server.env ?? {}) });
  }

  /** Whatever the child wrote to stderr, for error messages only. */
  get stderr(): string {
    return this.stderrText.trim();
  }

  /**
   * The first failure this transport observed, retained so the error a caller
   * sees is the REASON the connection ended rather than the generic "closed"
   * rejection the protocol layer raises for every request still in flight.
   */
  get failure(): Error | undefined {
    return this.firstFailure;
  }

  async start(): Promise<void> {
    if (this.child !== undefined) throw new Error(`${this.label} transport already started`);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.server.command, [...(this.server.args ?? [])], {
        env: this.childEnv,
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      throw new McpTransportError(`${this.label} failed to spawn`, { cause });
    }
    this.child = child;

    child.once('error', (error) => {
      this.fail(new McpTransportError(`${this.label} failed to start: ${error.message}`, { cause: error }));
    });
    child.once('exit', (code, signal) => {
      if (this.closed) return;
      this.fail(new McpTransportError(
        `${this.label} exited before the exchange completed (code=${String(code)}, signal=${String(signal)})`
        + (this.stderr ? `: ${this.stderr}` : ''),
      ));
    });
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stdout.on('error', (error) => {
      this.fail(new McpTransportError(`${this.label} stdout failed: ${error.message}`, { cause: error }));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: stderr is only ever quoted back in an error message, and an
      // unbounded sink here would defeat the stdout cap next door.
      if (this.stderrText.length < 8_192) this.stderrText += chunk.toString('utf8');
    });
    child.stdin.on('error', (error) => {
      this.fail(new McpTransportError(`${this.label} stdin failed: ${error.message}`, { cause: error }));
    });
  }

  /**
   * Consume one stdout chunk under both bounds. Bytes are counted BEFORE the
   * read buffer sees them, so an oversized stream is refused whether it
   * arrives as one frame or as a flood of well-formed small ones.
   */
  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.stdoutBytes += chunk.byteLength;
    const cap = this.options.maxStdoutBytes;
    if (cap !== undefined && this.stdoutBytes > cap) {
      this.fail(new McpAuthorityError(
        `${this.label} wrote more than ${cap} bytes of stdout before completing the exchange`,
      ));
      return;
    }
    this.readBuffer.append(chunk);
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (cause) {
        // A frame over `MCP_MAX_FRAME_BYTES`, or one that is not a valid
        // JSON-RPC message. Both are the server's own answer.
        this.fail(new McpAuthorityError(
          `${this.label} sent a frame this client refuses: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        ));
        return;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  /**
   * Record the first failure, report it, and end the connection.
   *
   * Tearing down here is what makes a bound enforceable: `onerror` alone is
   * out-of-band and leaves every in-flight request waiting for its own
   * timeout, so a server that blew the stdout cap would still hold the caller
   * for the full deadline. Closing rejects them immediately, and
   * {@link failure} carries the real reason out.
   */
  private fail(error: Error): void {
    this.firstFailure ??= error;
    this.onerror?.(error);
    void this.close();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (child === undefined || this.closed) {
      throw new McpTransportError(`${this.label} is not connected`);
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(serializeMessage(message), (error) => {
        if (error) reject(new McpTransportError(`${this.label} write failed: ${error.message}`, { cause: error }));
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.readBuffer.clear();
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.onclose?.();
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin.end();
    child.kill('SIGTERM');
    const forced = setTimeout(() => child.kill('SIGKILL'), CHILD_TERMINATION_GRACE_MS);
    forced.unref?.();
    await exited;
    clearTimeout(forced);
    this.onclose?.();
  }
}

/**
 * One connected stdio MCP server.
 *
 * The lifecycle is explicit and total: `connect()` starts the child and
 * completes `initialize`, `close()` always ends the child. There is no lazy
 * reconnect and no keep-alive hook — a caller that needs the server holds the
 * client, and a caller that is finished closes it.
 */
export class McpStdioClient {
  private readonly client: Client;
  private readonly transport: BoundedStdioTransport;
  private readonly label: string;
  private readonly timeoutMs: number;
  private connected = false;

  constructor(
    private readonly server: McpStdioServerSpec,
    private readonly options: McpStdioClientOptions,
  ) {
    this.label = options.label ?? 'MCP server';
    this.timeoutMs = options.timeoutMs ?? MCP_DEFAULT_REQUEST_TIMEOUT_MS;
    this.transport = new BoundedStdioTransport(server, options, this.label);
    this.client = new Client(CLIENT_INFO, {
      // No `sampling`, no `elicitation`, no `roots`. Declaring a capability is
      // what invites the server to drive this process, and nothing in this SDK
      // fulfils those requests: a server that asks would be answered by
      // nobody, so it is never told it may ask. `versionNegotiation` is left
      // at its default (`legacy`), so this is the plain 2025 `initialize`
      // handshake with no `server/discover` probe and no sibling spawn.
      capabilities: {},
      // A server that answers for a capability it never advertised is
      // answering for authority it does not have. Fail closed rather than
      // silently returning an empty list.
      enforceStrictCapabilities: true,
      // The validator choice is named here rather than inherited, because the
      // package's default is resolved by the BUNDLER, not by us:
      // `@modelcontextprotocol/client` picks its provider through the
      // `./_shims` conditional export, and the `node`/`default` branch is the
      // ajv-backed one, which compiles every schema with `new Function`. A
      // host that bundles this SDK for a runtime that refuses runtime code
      // generation (a CSP-locked page, workerd, any `--disallow-code-generation`
      // policy) would then carry a codegen provider it never asked for, decided
      // by its bundler's resolution conditions rather than by this package.
      // `CfWorkerJsonSchemaValidator` is the published, codegen-free provider
      // (`@cfworker/json-schema`, an interpreter over the schema), so naming it
      // makes the runtime choice ours and identical on every host.
      //
      // Scope, exactly: this validator is consulted in one place — the
      // package's `_compileOutputValidator`, which validates a tool result's
      // `structuredContent` against that tool's declared `outputSchema`. It is
      // not used for `inputSchema`, for protocol message validation, or for
      // anything this SDK does outside `tools/call`. A tool without an
      // `outputSchema` never reaches it at all.
      //
      // This covers the RUNTIME choice only. `dist/index.js` still externalises
      // `@modelcontextprotocol/client`, so whether the consumer's final bundle
      // is codegen-free also depends on how their bundler resolves `_shims`;
      // see `../__tests__/dist-subpath-closure.test.ts`.
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    });
  }

  /**
   * Start the child and complete `initialize`.
   *
   * An attested implementation is re-measured BEFORE the spawn, every time:
   * the artifact, the interpreter of an `interpreter+bundle`, and the
   * environment this child is about to be handed. Resolve and launch are two
   * different moments, and an identity established at the first one asserts
   * nothing about the second — so the check runs here rather than being cached
   * with the identity.
   *
   * A failure is a refusal, not a downgrade: the connection is never opened
   * with the identity quietly demoted to `unavailable`, because a server that
   * was attested and no longer measures the same is a server that changed
   * under a claim somebody relied on. It surfaces as {@link McpAuthorityError}
   * so the daemon declines the offer permanently — re-offering spawns the same
   * changed file and reaches the same verdict.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) throw new Error(`${this.label} is already connected`);
    try {
      await assertToolImplementationBeforeSpawn(
        this.label,
        this.options.implementation,
        // The environment the child is about to receive, not the one this
        // client was configured with: `server.env` is layered on for
        // SDK-reserved servers, and an identity binds what reaches the child.
        this.transport.childEnv,
        this.options.implementationFsProbe,
      );
    } catch (cause) {
      await this.close();
      if (cause instanceof ToolImplementationReverifyError) {
        throw new McpAuthorityError(cause.message, { cause });
      }
      throw cause;
    }
    try {
      await this.client.connect(this.transport, {
        timeout: this.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      await this.close();
      throw this.classify(cause, 'initialize');
    }
    this.connected = true;
  }

  /** The server's self-reported identity, as returned by `initialize`. */
  serverInfo(): { readonly name: string; readonly version: string } {
    const info = this.client.getServerVersion();
    if (info === undefined || typeof info.name !== 'string' || typeof info.version !== 'string') {
      throw new McpAuthorityError(`${this.label} did not identify itself in its initialize result`);
    }
    return Object.freeze({ name: info.name, version: info.version });
  }

  /** The protocol version this connection negotiated. */
  protocolVersion(): string {
    const version = this.client.getNegotiatedProtocolVersion();
    if (typeof version !== 'string' || version.length === 0) {
      throw new McpAuthorityError(`${this.label} negotiated no protocol version`);
    }
    return version;
  }

  /** Every tool the server reports, across every page. */
  async listTools(signal?: AbortSignal): Promise<readonly Tool[]> {
    try {
      const result = await this.client.listTools(undefined, {
        timeout: this.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      return Object.freeze([...result.tools]);
    } catch (cause) {
      throw this.classify(cause, 'tools/list');
    }
  }

  /**
   * Invoke one tool. An aborted `signal` cancels in band — the protocol layer
   * sends `notifications/cancelled` for the in-flight request — so a cancelled
   * call does not orphan work on the server.
   */
  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>> | undefined,
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<CallToolResult> {
    try {
      return await this.client.callTool(
        { name, ...(args === undefined ? {} : { arguments: { ...args } }) },
        {
          timeout: options?.timeoutMs ?? this.timeoutMs,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (cause) {
      throw this.classify(cause, `tools/call ${name}`);
    }
  }

  /** Always safe to call, including before `connect()` and more than once. */
  async close(): Promise<void> {
    this.connected = false;
    try {
      await this.client.close();
    } catch {
      // The client's own close only fails when the transport is already gone,
      // which is the state close() is trying to reach.
    }
    await this.transport.close();
  }

  /**
   * Map one thrown value onto the two-way split callers act on.
   *
   * The split is retryability, and it follows WHO is at fault. A server that
   * answered — with a result that is not a valid `tools/list`, with a result
   * type nothing can read, with more pages than the client will walk, or for a
   * capability it never advertised — has stated a permanent fact about itself;
   * re-offering the task would ask the same command and get the same answer
   * forever. A server that timed out, closed, or could not be written to may
   * well succeed later.
   *
   * A JSON-RPC error response the server sent is split the same way, by
   * {@link AUTHORITY_PROTOCOL_ERROR_CODES}: a rejection of the REQUEST is
   * permanent, a report of the server's own condition is not.
   *
   * An {@link McpAuthorityError} raised inside the transport (an oversized
   * stream, a refused frame) surfaces through the client's `onerror` funnel
   * and arrives here unchanged.
   */
  private classify(cause: unknown, phase: string): Error {
    if (cause instanceof McpAuthorityError || cause instanceof McpTransportError) return cause;
    if (cause instanceof SdkError && AUTHORITY_ERROR_CODES.has(cause.code)) {
      return new McpAuthorityError(`${this.label} ${phase} failed: ${cause.message}`, { cause });
    }
    if (cause instanceof ProtocolError && AUTHORITY_PROTOCOL_ERROR_CODES.has(cause.code)) {
      return new McpAuthorityError(
        `${this.label} ${phase} failed: the server answered JSON-RPC error ${cause.code}: ${cause.message}`,
        { cause },
      );
    }
    // A transport failure tears the connection down, so the protocol layer
    // rejects the in-flight request with a generic "closed" error. The reason
    // the connection ended is the honest answer.
    const observed = this.transport.failure;
    if (observed !== undefined) return observed;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const stderr = this.transport.stderr;
    return new McpTransportError(
      `${this.label} ${phase} failed: ${detail}${stderr ? `: ${stderr}` : ''}`,
      { cause },
    );
  }
}
