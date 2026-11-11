import type { spawnOwnedLineProcess } from './owned-line-process';
import type { spawnOwnedTerminalProcess } from './owned-terminal-process';
// Self-contained: the build copies this declaration to dist for the private `#byok-acp-runtime` import.
/** A resume of a missing native session: the vendored typed error, never matched by name or message. */
export declare class SessionNotFoundError extends Error {
  readonly name: 'SessionNotFoundError';
  readonly sessionId: string;
  readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };
  constructor(sessionId: string, message: string, cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> });
}
/** The open failed because the runtime refused the login (`auth`) or the model (`model_unavailable`): the vendored typed error, never matched by name or message. */
export declare class RuntimeFailureError extends Error {
  readonly name: 'RuntimeFailureError';
  readonly failure: string;
}
/** The runtime refused a session option at open: the vendored typed error, never matched by name or message. */
export declare class UnsupportedOptionError extends Error {
  readonly name: 'UnsupportedOptionError';
  readonly option: string;
}
export interface AcpControl {
  // ControlResult also permits an exit response with a numeric or null code.
  response: { body: { kind: string; code?: string | number | null; reason?: string } };
}
/** Structural SPI: one complete kernel record of an ACP session. */
export interface AcpRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly kind: string;
  readonly body: unknown;
}
/** The vendored ACP AdapterSession, narrowed to what the SDK calls. */
export interface RawAcpSession {
  readonly id: string;
  /** `inputId` names the prompt, so a runtime with native turns (Grok) reports its turn with that id. */
  prompt(input: string, options?: { inputId?: string }): Promise<AcpControl>;
  /** Held by the session until the active turn (also the runtime's own) closes, then sent as a prompt carrying `inputId`. */
  queue(input: string, options: { inputId: string }): Promise<AcpControl>;
  /** Takes held input back before it is sent; `not_queued` once the drain sent it. Every vendored ACP session has it. */
  withdraw?(inputId: string): Promise<AcpControl>;
  steer?(input: string): Promise<AcpControl>;
  abort(): Promise<AcpControl>;
  records(): readonly AcpRecord[];
  dispose(): Promise<void>;
}
/** Structural SPI: the parts of one `session/request_permission` the SDK reads. */
export interface AcpPermissionRequest {
  readonly toolCall: {
    readonly toolCallId: string;
    readonly kind?: string | null;
    readonly rawInput?: unknown;
    readonly locations?: readonly { readonly path: string }[] | null;
  };
  readonly options: readonly { readonly optionId: string; readonly kind: string }[];
}
export interface AcpPermissionResponse {
  readonly outcome: { readonly outcome: 'selected'; readonly optionId: string };
}
/** Every vendored ACP runtime start: the SDK owns the agent process, each hosted terminal process and the environment. */
export type StartAcpSession = (
  spawn: typeof spawnOwnedLineProcess,
  spawnTerminal: typeof spawnOwnedTerminalProcess,
  installation: { kind: 'available'; via: 'executable'; command: string; version?: string },
  options: {
    cwd: string;
    env: Readonly<Record<string, string>>;
    resume?: string;
    model?: string;
    /** OAR SessionOptions.appendSystemPrompt: session-local instructions added to the runtime's built-in ones. */
    appendSystemPrompt?: string;
    /** OAR SessionOptions.launchArgs: joined to the profile's argv where the profile places them. */
    launchArgs?: readonly string[];
    /** OAR SessionOptions.mcpServers: the ACP `mcpServers` of session/new and session/resume. */
    mcpServers?: readonly (
      | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
      | { readonly name: string; readonly type: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>> }
    )[];
  },
  hooks?: {
    onReady?: (sessionId: string) => void;
    onRecord?: (record: AcpRecord) => void;
    /** Answers each `session/request_permission`. Absent, every request is cancelled. */
    onPermission?: (request: AcpPermissionRequest) => AcpPermissionResponse;
  },
) => Promise<RawAcpSession>;
/** OAR's Grok Build profile: `grok agent --always-approve --no-leader stdio`. */
export declare const grokSession: StartAcpSession;
/** OAR's Antigravity profile: `agy acp --dangerously-skip-permissions --process-per-session`. */
export declare const antigravitySession: StartAcpSession;

/** Native OpenCode 1 and 2 ACP; requires the installation's probed version. */
export declare const opencodeSession: StartAcpSession;

export declare class SessionUnavailableError extends Error {
  readonly name: 'SessionUnavailableError';
  readonly sessionId: string;
  readonly reason: 'archived' | 'in_use';
  readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };
  constructor(sessionId: string, message: string, details: { readonly reason: 'archived' | 'in_use'; readonly method: string; readonly native: Readonly<Record<string, unknown>> });
}
