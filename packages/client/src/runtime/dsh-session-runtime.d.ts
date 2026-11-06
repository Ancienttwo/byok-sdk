import type { spawnOwnedLineProcess } from './owned-line-process';
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
export interface RawDshSession {
  readonly id: string;
  prompt(input: string): Promise<DshControl>;
  steer(input: string): Promise<DshControl>;
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
  readonly name: 'UnsupportedOptionError';
  readonly option: string;
}
export declare function dshSession(
  spawn: typeof spawnOwnedLineProcess,
  installation: { kind: 'available'; via: 'executable'; command: string },
  options: {
    cwd: string;
    model: string;
    resume?: string;
    mcpServers?: readonly (
      | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
      | { readonly name: string; readonly type: 'http'; readonly url: string; readonly headers?: Readonly<Record<string, string>> }
    )[];
    /** The process directory, the SDK patches before the bridge overlay, and the explicit environment. */
    launch: { directory: string; patches: readonly string[]; env: Readonly<Record<string, string>> };
  },
  hooks?: {
    onReady?: (sessionId: string) => void;
    onRecord?: (record: DshRecord) => void;
  },
): Promise<RawDshSession>;
