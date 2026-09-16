/**
 * `@byok-sdk/client/mcp-server` — a tools-only MCP **server** over stdio.
 *
 * `src/mcp/client.ts` is this SDK's single MCP *client* authority. This module
 * is the same thing for the *server* side, with the same scope discipline:
 * transport plus baseline, never product semantics. It exists because four
 * SDK-reserved helpers each hand-rolled the same NDJSON loop, the same
 * `initialize` answer and the same `-32601` fallthrough — four independent
 * places for one wire contract to drift, and all four drifted the same way, by
 * ECHOING whatever `protocolVersion` a peer offered.
 *
 * ## What this core decides, and what it never decides
 *
 * It maps PROTOCOL faults only: `-32700` parse, `-32600` invalid request (a
 * message that is not a valid Request object: a missing or non-`"2.0"`
 * `jsonrpc`, a non-string `method`, an unusable id, a duplicate id, a
 * top-level batch array), `-32602` invalid params (a `tools/call` whose
 * `params` is not an object, whose `params.name` is not a non-empty string, or
 * which carries an `arguments` key holding anything but a plain object),
 * `-32601` unknown method, `-32000` for the in-flight refusal,
 * and `-32603` for a tool handler that threw something other than an
 * {@link McpServerToolError} — the one code with no server-authored mapping
 * available, since a handler that throws untyped left the core nothing to
 * forward. Everything about a TOOL — which names exist, what an invalid
 * argument is, whether a domain failure is an error response or a successful
 * result carrying a refusal — belongs to the server that supplied `callTool`.
 * The approval helper's fail-closed `{behavior:'deny'}` RESULT is the sharpest
 * case: a permission-prompt-tool call that never cleanly answers makes claude
 * abandon the turn, so that failure must stay a `result`, and a transport core
 * must not be able to turn it into an `error`.
 *
 * The `-32600`/`-32602` split follows JSON-RPC 2.0 §5.1 literally: `-32600`
 * Invalid Request is "The JSON sent is not a valid Request object", `-32602`
 * Invalid params is "Invalid method parameter(s)". A `tools/call` whose
 * `params` is an object IS a valid Request object, so a `name` or `arguments`
 * that is the wrong shape inside it is a parameter fault and gets `-32602` —
 * and it gets it before the handler runs, because a handler must never see a
 * call whose declared shape the wire contract already refuses. An `arguments`
 * key that is absent is NOT a fault: the MCP `tools/call` schema makes it
 * optional, so absence reaches the handler as `undefined` and the server
 * decides what a call with no arguments means.
 *
 * ## Advertised protocol versions
 *
 * `MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS` is `['2025-11-25', '2025-06-18',
 * '2024-11-05']` and is FINAL. It is the intersection of the revisions proven
 * to interoperate with `@modelcontextprotocol/client@2.0.0` and the revisions
 * this core actually implements. Two proven-interoperable revisions are
 * deliberately excluded:
 *
 * - `2025-03-26`, batching. Its basic spec
 *   (<https://modelcontextprotocol.io/specification/2025-03-26/basic>, §Batching)
 *   says "MCP implementations MAY support sending JSON-RPC batches, but MUST
 *   support receiving JSON-RPC batches", and the same revision's changelog
 *   records the arrival: "Added support for JSON-RPC batching (PR #228)". This
 *   core refuses batch receipt outright, so advertising the revision would be a
 *   conformance claim the code does not meet.
 * - `2024-10-07`, no citable spec.
 *   <https://modelcontextprotocol.io/specification/2024-10-07/basic> returns
 *   404. A revision with no reachable normative text must not be advertised.
 *
 * And the three that stay:
 *
 * - `2024-11-05` basic has no Batching section, so batch receipt is not a MUST.
 * - `2025-06-18` changelog: "Remove support for JSON-RPC batching (PR #416)";
 *   its basic spec has no Batching section.
 * - `2025-11-25` likewise has no Batching section. It adds two constraints this
 *   core honours: an error response may omit the id only when the request id
 *   could not be read, and JSON Schema's default dialect is 2020-12, so a
 *   caller's `inputSchema` must be valid 2020-12 or declare its own `$schema`.
 *   That schema is caller authority; this core passes it through verbatim.
 *
 * Selection never echoes: a `protocolVersion` in the list is returned, anything
 * else gets the list's newest entry and the peer decides. The official client
 * accepts any member of its own legacy list regardless of what it offered, and
 * fails closed with a quotable error otherwise.
 *
 * ## What is not here
 *
 * No `resources/*`, `prompts/*`, `logging/*`, `tasks/*`, `completion/*`, no
 * `server/discover`, no modern (2026-07-28+) era, no HTTP or SSE, no batching —
 * and no option through which a caller could ADVERTISE any of them. The
 * capabilities object is authored here, not passed through, because a client
 * routes requests on the advertisement and a capability the core does not
 * implement must never appear in it.
 */
import { createBoundedFrameWriter, createBoundedLineReader } from './framing';
import { classifyJsonRpcMessage, isUsableRequestId, SeenRequestIds, type McpServerRequestId } from './dispatch';

/** The revisions this core implements and will answer `initialize` with. Final; see the module header for each entry's and each exclusion's citation. */
export const MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2024-11-05'];

/** Inbound: maximum bytes between two newlines before the session fails closed. */
export const MCP_SERVER_MAX_LINE_BYTES = 1_048_576;

/**
 * Outbound: maximum UTF-8 bytes of one encoded frame. Matches
 * `MCP_MAX_FRAME_BYTES` in `src/mcp/client.ts`, so an SDK server and an SDK
 * client agree on the same 1 MiB ceiling in both directions.
 */
export const MCP_SERVER_MAX_FRAME_BYTES = 1_048_576;

/** Maximum `tools/call` requests in flight or queued at once. */
export const MCP_SERVER_MAX_IN_FLIGHT = 64;

/** Maximum distinct request ids remembered per session for duplicate detection. */
export const MCP_SERVER_MAX_SEEN_IDS = 4096;

/** The revision assumed for id-echo rules before `initialize` has negotiated one. */
const DEFAULT_PROTOCOL_VERSION = MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS[0] as string;

/** The revision whose error responses OMIT the id when no usable id could be read, rather than nulling it. */
const OMITS_UNREADABLE_ID = '2025-11-25';

export interface McpServerToolDefinition {
  readonly name: string;
  readonly description?: string;
  /** Caller-supplied, passed through verbatim. The core never authors, validates against, or rewrites it. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpServerToolCall {
  readonly name: string;
  /** The peer's `params.arguments` when it is a JSON object; `undefined` otherwise. */
  readonly arguments: Readonly<Record<string, unknown>> | undefined;
  /** Aborted when the peer sends `notifications/cancelled` for this request id. */
  readonly signal: AbortSignal;
}

/**
 * The handler's return value is written as the JSON-RPC `result` VERBATIM, and
 * a thrown {@link McpServerToolError} as the `error`. Mapping a domain failure
 * onto either is the SERVER'S decision, not this core's: a handler that returns
 * normally always produces a `result`.
 */
export type McpServerToolHandler = (call: McpServerToolCall) => Promise<Record<string, unknown>>;

/** Opt-in. A handler throws this to author its own JSON-RPC `error`; returning normally always produces a `result`. */
export class McpServerToolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpServerToolError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** One encoded frame exceeded the outbound cap. Nothing was written for it — never a truncated prefix. */
export class McpServerFrameTooLargeError extends Error {
  /** The id of the request whose response could not be sent, or `undefined` for an unsolicited notification. */
  readonly requestId: McpServerRequestId | undefined;
  readonly bytes: number;
  readonly limitBytes: number;

  constructor(requestId: McpServerRequestId | undefined, bytes: number, limitBytes: number) {
    super(
      `an outbound MCP frame of ${bytes} bytes exceeds the ${limitBytes}-byte limit` +
        (requestId === undefined ? '' : ` (request id ${JSON.stringify(requestId)})`),
    );
    this.name = 'McpServerFrameTooLargeError';
    this.requestId = requestId;
    this.bytes = bytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Supplying one of these is the ONLY way to make the core advertise
 * `{ tools: { listChanged: true } }`. The core subscribes once at construction
 * and unsubscribes when the session closes.
 */
export interface McpServerToolsListChangedEmitter {
  /** Called once with the notifier to invoke when the tool list changes. Returns an unsubscribe. */
  onToolsListChanged(notify: () => void): () => void;
}

export type McpServerCloseReason =
  /** The read side ended. */
  | { readonly kind: 'eof' }
  /** A single inbound line exceeded `maxLineBytes`; nothing was parsed or answered. */
  | { readonly kind: 'frame-limit'; readonly limitBytes: number }
  /** A single outbound frame exceeded `maxOutboundFrameBytes`; nothing was written for it. */
  | { readonly kind: 'outbound-frame-limit'; readonly limitBytes: number; readonly bytes: number; readonly error: McpServerFrameTooLargeError };

export interface McpServerOptions {
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly tools: readonly McpServerToolDefinition[];
  readonly callTool: McpServerToolHandler;
  /**
   * Opt-in only. Supplying a real emitter makes the core advertise
   * `{ tools: { listChanged: true } }` and emit
   * `notifications/tools/list_changed`. Omitted, the core advertises
   * `{ tools: {} }`. There is no other way to influence the advertised
   * capabilities.
   */
  readonly toolsListChanged?: McpServerToolsListChangedEmitter;
  /** Default {@link MCP_SERVER_MAX_LINE_BYTES}. Fail closed and close on exceed. */
  readonly maxLineBytes?: number;
  /** Default {@link MCP_SERVER_MAX_FRAME_BYTES}. Outbound cap; an over-cap frame is never partially written. */
  readonly maxOutboundFrameBytes?: number;
  /** Default {@link MCP_SERVER_MAX_IN_FLIGHT}. Over-limit `tools/call` requests get a typed `-32000` refusal. */
  readonly maxInFlight?: number;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** Called at most once, when the read side ends or a bound is breached. An explicit `close()` does not fire it. */
  readonly onClose?: (reason: McpServerCloseReason) => void;
}

export interface McpServerHandle {
  /** Stops reading and writing and aborts every in-flight call. Does NOT fire `onClose`. Idempotent. */
  close(): void;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const IN_FLIGHT_EXHAUSTED = -32000;

/**
 * Serves `options.tools` as a tools-only MCP server over one NDJSON stdio
 * session.
 *
 * Throws at construction for the two caller faults it can see — an empty tool
 * list and two tools sharing a name — because a server that advertises the
 * `tools` capability with nothing callable is a silent dead end: the peer
 * connects, then every `tools/call` fails on its side.
 */
export function serveMcpOverStdio(options: McpServerOptions): McpServerHandle {
  if (options.tools.length === 0) {
    throw new Error('serveMcpOverStdio requires at least one tool: a tools-only server with no tools is unreachable');
  }
  const names = new Set<string>();
  for (const tool of options.tools) {
    if (names.has(tool.name)) {
      throw new Error(`serveMcpOverStdio received two tools named ${JSON.stringify(tool.name)}`);
    }
    names.add(tool.name);
  }

  const maxLineBytes = options.maxLineBytes ?? MCP_SERVER_MAX_LINE_BYTES;
  const maxOutboundFrameBytes = options.maxOutboundFrameBytes ?? MCP_SERVER_MAX_FRAME_BYTES;
  const maxInFlight = options.maxInFlight ?? MCP_SERVER_MAX_IN_FLIGHT;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  const capabilities: Record<string, unknown> =
    options.toolsListChanged === undefined ? { tools: {} } : { tools: { listChanged: true } };

  const seenIds = new SeenRequestIds(MCP_SERVER_MAX_SEEN_IDS);
  /** Request id -> the controller for the `tools/call` still allowed to answer. Retired at cancel time. */
  const activeCalls = new Map<string, AbortController>();
  /** Every handler promise not yet settled, cancelled ones included: the in-flight bound counts these, and EOF awaits them. */
  const outstanding = new Set<Promise<void>>();

  let negotiatedVersion: string | undefined;
  let closed = false;
  let reader: { stop(): void } | undefined;
  let unsubscribeListChanged: (() => void) | undefined;

  const writer = createBoundedFrameWriter({ output, maxFrameBytes: maxOutboundFrameBytes });

  function send(message: Record<string, unknown>, requestId?: McpServerRequestId): void {
    if (closed) return;
    const oversize = writer.write(`${JSON.stringify(message)}\n`);
    if (oversize !== undefined) closeOutboundLimit(oversize, requestId);
  }

  /**
   * An error envelope under the negotiated revision's id rules. A usable id is
   * always echoed; only an id that could not be read at all is omitted (under
   * `2025-11-25`) or nulled (under the two older revisions, which is the one
   * place `id: null` is correct per JSON-RPC 2.0).
   */
  function sendError(id: McpServerRequestId | undefined, code: number, message: string): void {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code, message } }, id);
      return;
    }
    const version = negotiatedVersion ?? DEFAULT_PROTOCOL_VERSION;
    if (version === OMITS_UNREADABLE_ID) {
      send({ jsonrpc: '2.0', error: { code, message } });
      return;
    }
    send({ jsonrpc: '2.0', id: null, error: { code, message } });
  }

  function abortEverything(): void {
    for (const controller of activeCalls.values()) controller.abort();
    activeCalls.clear();
  }

  function closeOutboundLimit(bytes: number, requestId: McpServerRequestId | undefined): void {
    if (closed) return;
    closed = true;
    const error = new McpServerFrameTooLargeError(requestId, bytes, maxOutboundFrameBytes);
    writer.stop();
    reader?.stop();
    unsubscribeListChanged?.();
    abortEverything();
    options.onClose?.({ kind: 'outbound-frame-limit', limitBytes: maxOutboundFrameBytes, bytes, error });
  }

  function closeFrameLimit(): void {
    if (closed) return;
    closed = true;
    writer.stop();
    reader?.stop();
    unsubscribeListChanged?.();
    abortEverything();
    options.onClose?.({ kind: 'frame-limit', limitBytes: maxLineBytes });
  }

  async function closeEof(): Promise<void> {
    if (closed) return;
    closed = true;
    options.onClose?.({ kind: 'eof' });
    abortEverything();
    writer.stop();
    reader?.stop();
    unsubscribeListChanged?.();
    await Promise.allSettled([...outstanding]);
  }

  function handleInitialize(id: McpServerRequestId, params: Record<string, unknown> | undefined): void {
    const requested = params?.protocolVersion;
    const selected =
      typeof requested === 'string' && MCP_SERVER_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
    negotiatedVersion = selected;
    send(
      {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: selected, capabilities, serverInfo: options.serverInfo },
      },
      id,
    );
  }

  function handleToolsList(id: McpServerRequestId): void {
    const tools = options.tools.map((tool) =>
      tool.description === undefined
        ? { name: tool.name, inputSchema: tool.inputSchema }
        : { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
    );
    send({ jsonrpc: '2.0', id, result: { tools } }, id);
  }

  function handleToolsCall(id: McpServerRequestId, params: Record<string, unknown> | undefined): void {
    if (outstanding.size >= maxInFlight) {
      sendError(id, IN_FLIGHT_EXHAUSTED, `at most ${maxInFlight} tools/call requests may be in flight at once`);
      return;
    }
    // `classifyJsonRpcMessage` hands over `undefined` both for an absent
    // `params` and for a by-position array, and `tools/call` accepts neither.
    if (params === undefined) {
      sendError(id, INVALID_PARAMS, 'tools/call requires an object params');
      return;
    }
    const name = params.name;
    if (typeof name !== 'string' || name.length === 0) {
      sendError(id, INVALID_PARAMS, 'tools/call requires a non-empty string params.name');
      return;
    }
    // Present-but-wrong and absent are different facts. An `arguments` key the
    // peer actually wrote must be a plain object or the call is refused here;
    // silently rewriting `null`, an array or a scalar to `undefined` would hand
    // the handler a call the peer never made.
    let callArguments: Record<string, unknown> | undefined;
    if (Object.prototype.hasOwnProperty.call(params, 'arguments')) {
      const argumentsValue = params.arguments;
      if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
        sendError(id, INVALID_PARAMS, 'tools/call params.arguments must be an object when present');
        return;
      }
      callArguments = argumentsValue as Record<string, unknown>;
    }

    const key = SeenRequestIds.key(id);
    const controller = new AbortController();
    activeCalls.set(key, controller);

    /** `true` only while this call is still the one allowed to answer: a cancel retires the id at abort time. */
    const stillOurs = (): boolean => activeCalls.get(key) === controller;

    const task = (async (): Promise<void> => {
      try {
        const result = await options.callTool({ name, arguments: callArguments, signal: controller.signal });
        if (!stillOurs()) return;
        activeCalls.delete(key);
        send({ jsonrpc: '2.0', id, result }, id);
      } catch (error) {
        if (!stillOurs()) return;
        activeCalls.delete(key);
        if (error instanceof McpServerToolError) {
          send(
            {
              jsonrpc: '2.0',
              id,
              error:
                error.data === undefined
                  ? { code: error.code, message: error.message }
                  : { code: error.code, message: error.message, data: error.data },
            },
            id,
          );
          return;
        }
        send(
          {
            jsonrpc: '2.0',
            id,
            error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) },
          },
          id,
        );
      }
    })();
    outstanding.add(task);
    void task.finally(() => {
      outstanding.delete(task);
    });
  }

  function handleCancelled(params: Record<string, unknown> | undefined): void {
    const requestId = params?.requestId;
    if (!isUsableRequestId(requestId)) return;
    const key = SeenRequestIds.key(requestId);
    const controller = activeCalls.get(key);
    if (controller === undefined) return;
    // Retire the id BEFORE aborting: a late settle must find the slot gone and
    // write nothing. A response after cancel is an observable protocol
    // violation — the peer logs `Received a response for an unknown message ID`
    // — and the handler promise stays in `outstanding` so the in-flight count
    // still decrements on settle, not on cancel.
    activeCalls.delete(key);
    controller.abort();
  }

  function handleLine(line: string): void {
    if (closed) return;
    if (line.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      sendError(undefined, PARSE_ERROR, 'parse error: not valid JSON');
      return;
    }

    const classified = classifyJsonRpcMessage(parsed);
    if (classified.kind === 'invalid') {
      sendError(classified.id, INVALID_REQUEST, classified.message);
      return;
    }
    if (classified.kind === 'notification') {
      if (classified.method === 'notifications/cancelled') handleCancelled(classified.params);
      // `notifications/initialized` and every unknown notification are accepted
      // and produce no response — a notification is never answered, not even on
      // error.
      return;
    }

    if (seenIds.has(classified.id)) {
      sendError(classified.id, INVALID_REQUEST, 'request id already used in this session');
      return;
    }
    seenIds.add(classified.id);

    switch (classified.method) {
      case 'initialize':
        handleInitialize(classified.id, classified.params);
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id: classified.id, result: {} }, classified.id);
        return;
      case 'tools/list':
        handleToolsList(classified.id);
        return;
      case 'tools/call':
        handleToolsCall(classified.id, classified.params);
        return;
      default:
        sendError(classified.id, METHOD_NOT_FOUND, `unknown method: ${classified.method}`);
    }
  }

  reader = createBoundedLineReader({
    input,
    maxLineBytes,
    onLine: handleLine,
    onLimit: closeFrameLimit,
    onEnd: () => {
      void closeEof();
    },
  });

  unsubscribeListChanged = options.toolsListChanged?.onToolsListChanged(() => {
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  });

  return {
    close(): void {
      if (closed) return;
      closed = true;
      writer.stop();
      reader?.stop();
      unsubscribeListChanged?.();
      abortEverything();
    },
  };
}
