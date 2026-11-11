/**
 * The private bridge between Electron main and the Host child: NDJSON over the
 * child's stdin and stdout, one JSON message per line. Shell and Host ship in one
 * app version, so the version is compared exactly and a mismatch fails closed;
 * there is no negotiation. Main sends requests; the Host sends replies and
 * `state` pushes, which carry no id.
 */
import { ACTIVITY_DOMAIN, type ActivityMethods } from './domains/activity.ts';
import { K8_DOMAIN, type K8Methods } from './domains/k8.ts';
import { KEYS_DOMAIN, type KeysMethods } from './domains/keys.ts';
import { SETTINGS_DOMAIN, type SettingsMethods } from './domains/settings.ts';

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

/** The bridge's own methods. `hello` and `shutdown` belong to main alone. */
export interface CoreMethods {
  hello: { params: { bridgeVersion: number }; result: { bridgeVersion: number } };
  status: { params: undefined; result: HostState };
  shutdown: { params: undefined; result: null };
}

/**
 * Every bridge method with its params and result: the core methods and each
 * domain's (`src/bridge/domains/`). A name two modules declare fails to compile.
 */
export interface BridgeMethods extends CoreMethods, K8Methods, ActivityMethods, SettingsMethods, KeysMethods {}
export type BridgeMethod = keyof BridgeMethods;

const DOMAINS = [K8_DOMAIN, ACTIVITY_DOMAIN, SETTINGS_DOMAIN, KEYS_DOMAIN] as const;

/** The methods the renderer may call. Main answers {@link MAIN_METHODS} itself and forwards the rest to the Host. */
export const RENDERER_METHODS = ['status', ...DOMAINS.flatMap(domain => domain.renderer), ...DOMAINS.flatMap(domain => domain.main)] as const satisfies readonly BridgeMethod[];
export type RendererMethod = 'status' | (typeof DOMAINS)[number]['renderer'][number] | MainMethod;

/** The renderer methods main answers without the Host. */
export const MAIN_METHODS: readonly MainMethod[] = DOMAINS.flatMap(domain => domain.main);
export type MainMethod = (typeof DOMAINS)[number]['main'][number];

/** The methods the Host answers behind the bridge, besides `hello` and `shutdown`. */
export type HostMethods = Omit<BridgeMethods, 'hello' | 'shutdown' | MainMethod>;

/** What the preload exposes to the renderer as `window.byok`. */
export interface ByokBridge {
  call<M extends RendererMethod>(method: M, params: BridgeMethods[M]['params']): Promise<BridgeMethods[M]['result']>;
}

/**
 * `invalid_params`: a handler refused the params. `method_failed`: a handler
 * threw something other than an `invalid_params` `BridgeError`. Both answer one
 * call; the bridge keeps serving.
 */
export type BridgeErrorCode = 'bridge_version_mismatch' | 'hello_required' | 'unknown_method' | 'invalid_message' | 'host_exited'
  | 'invalid_params' | 'method_failed';

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
