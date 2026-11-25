import type { RuntimeInputOptions } from '../types';
import type { spawnOwnedLineProcess } from './owned-line-process';
export declare function dshMcpConfigs(
  servers: readonly (
    | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
    | { readonly name: string; readonly type: 'http'; readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly origin?: 'serveMcpTools' }
  )[] | undefined,
  cwd: string,
): readonly Record<string, unknown>[];
export interface DshControl {
  // ControlResult also permits an exit response with a numeric or null code.
  response: { body: { kind: string; code?: string | number | null; reason?: string } };
}
/** Structural SPI: one complete kernel record of a dsh session. */
export interface DshRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly kind: string;
  readonly body: unknown;
}
/** The vendored dsh AdapterSession, narrowed to what the SDK calls. */
export declare function dshSessionCapabilities(): { readonly images: false };

export interface RawDshSession {
  readonly id: string;
  readonly capabilities: { readonly images: boolean };
  prompt(input: string, options?: RuntimeInputOptions): Promise<DshControl>;
  steer(input: string, options?: RuntimeInputOptions): Promise<DshControl>;
  queue(input: string, options?: RuntimeInputOptions): Promise<DshControl>;
  abort(): Promise<DshControl>;
  records(): readonly DshRecord[];
  dispose(): Promise<void>;
}
/** A resume of a session dsh has no record of: the vendored typed error, never matched by name or message. */
export declare class SessionNotFoundError extends Error {
  readonly name: 'SessionNotFoundError';
  readonly sessionId: string;
  readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };
  constructor(sessionId: string, message: string, cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> });
}
/** The open failed for a class dsh reported: the vendored typed error, never matched by name or message. */
export declare class RuntimeFailureError extends Error {
  readonly name: 'RuntimeFailureError';
  readonly failure: string;
}
/** The runtime refused a session option at open: the vendored typed error, never matched by name or message. */
export declare class UnsupportedOptionError extends Error {
  readonly name: string;
  readonly option: string;
}
/** The open could not confirm the requested model from the runtime's readback: the vendored typed error. */
export declare class ModelConfirmationError extends Error {
  readonly name: 'ModelConfirmationError';
  readonly requested: string;
  readonly reported: string | null;
  readonly catalogSelectorIds?: readonly string[];
}
export declare function dshSession(
  spawn: typeof spawnOwnedLineProcess,
  installation: { kind: 'available'; via: 'executable'; command: string; version: string },
  options: {
    cwd: string;
    model: string;
    effort?: string;
    resume?: string;
    mcpServers?: readonly (
      | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
      | { readonly name: string; readonly type: 'http'; readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly origin?: 'serveMcpTools' }
    )[];
    /** The process directory, the SDK patches before the bridge overlay, and the explicit environment. */
    launch: { directory: string; patches: readonly string[]; env: Readonly<Record<string, string>> };
    /** OAR SessionOptions.retainedBytes: past it the kernel elides the oldest native payloads. */
    retainedBytes: number;
    /** OAR SessionOptions.sessionLogUpload: every SDK open turns dsh's DeepSeek session-log upload off. */
    sessionLogUpload: 'off';
    /** OAR SessionOptions.appendSystemPrompt: one literal section after dsh's persona suffix, re-applied on every resume. */
    appendSystemPrompt?: string;
  },
  hooks?: {
    readonly credentialsForRedaction?: readonly string[];
    onReady?: (sessionId: string) => void;
    readonly onRouteMismatch?: () => void;
    onRecord?: (record: DshRecord) => void;
    /** Start cancellation; it also ends a wait for another opener's cold profile. */
    readonly signal?: AbortSignal;
  },
): Promise<RawDshSession>;

export declare class SessionUnavailableError extends Error {
  readonly name: 'SessionUnavailableError';
  readonly sessionId: string;
  readonly reason: 'archived' | 'in_use';
  readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };
  constructor(sessionId: string, message: string, details: { readonly reason: 'archived' | 'in_use'; readonly method: string; readonly native: Readonly<Record<string, unknown>> });
}
