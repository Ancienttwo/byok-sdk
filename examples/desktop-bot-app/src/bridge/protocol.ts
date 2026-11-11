/**
 * The private bridge between Electron main and the Host child: NDJSON over the
 * child's stdin and stdout, one JSON message per line. Shell and Host ship in one
 * app version, so the version is compared exactly and a mismatch fails closed;
 * there is no negotiation. Main sends requests; the Host sends replies and
 * `state` pushes, which carry no id.
 */
export const BRIDGE_VERSION = 1;

/** The ipcRenderer.invoke channel the preload forwards renderer calls on. */
export const BRIDGE_IPC_CHANNEL = 'byok:bridge';

/**
 * What the Host is doing. `stopped` is final for this Host process: a store
 * refused at start or a daemon halt, with its reason; main does not restart it.
 */
export type HostState =
  | { readonly state: 'starting'; readonly pid: number }
  | { readonly state: 'running'; readonly pid: number; readonly activeWork: number }
  | { readonly state: 'stopped'; readonly pid: number; readonly reason: string };

/** The one Host-to-main push: the Host's state after every change. */
export interface HostStateEvent { readonly event: 'state'; readonly state: HostState }

/** Every bridge method with its params and result. */
export interface BridgeMethods {
  hello: { params: { bridgeVersion: number }; result: { bridgeVersion: number } };
  status: { params: undefined; result: HostState };
  shutdown: { params: undefined; result: null };
}
export type BridgeMethod = keyof BridgeMethods;

/** The methods main forwards from the renderer. `hello` and `shutdown` belong to main alone. */
export const RENDERER_METHODS = ['status'] as const satisfies readonly BridgeMethod[];
export type RendererMethod = (typeof RENDERER_METHODS)[number];

/** What the preload exposes to the renderer as `window.byok`. */
export interface ByokBridge {
  call<M extends RendererMethod>(method: M, params: BridgeMethods[M]['params']): Promise<BridgeMethods[M]['result']>;
}

export type BridgeErrorCode = 'bridge_version_mismatch' | 'hello_required' | 'unknown_method' | 'invalid_message' | 'host_exited';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export interface BridgeRequest { readonly id: number; readonly method: string; readonly params?: unknown }
export type BridgeResponse =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: { readonly code: BridgeErrorCode; readonly message: string } };

export const encodeMessage = (message: BridgeRequest | BridgeResponse | HostStateEvent): string => `${JSON.stringify(message)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseLine = (line: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new BridgeError('invalid_message', 'Bridge line is not JSON');
  }
  if (!isRecord(value)) throw new BridgeError('invalid_message', 'Bridge line is not an object');
  return value;
};

const withId = (value: Record<string, unknown>): Record<string, unknown> & { id: number } => {
  if (!Number.isSafeInteger(value.id)) throw new BridgeError('invalid_message', 'Bridge message has no integer id');
  return value as Record<string, unknown> & { id: number };
};

/** Parses one line from the peer. A malformed line is a broken pipe, never skipped. */
export const decodeMessage = (line: string): Record<string, unknown> & { id: number } => withId(parseLine(line));

/** Main's read of a Host line: a state push, or a reply carrying its request id. */
export function decodeHostMessage(line: string): HostStateEvent | (Record<string, unknown> & { id: number }) {
  const value = parseLine(line);
  if (!('event' in value)) return withId(value);
  if (value.event !== 'state' || !isRecord(value.state)) throw new BridgeError('invalid_message', 'Bridge event is not a Host state');
  return value as unknown as HostStateEvent;
}
