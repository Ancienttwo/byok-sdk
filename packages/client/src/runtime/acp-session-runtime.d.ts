import type { RuntimeInputOptions } from '../types';
import type { spawnOwnedLineProcess } from './owned-line-process';
import type { spawnOwnedTerminalProcess } from './owned-terminal-process';
import type { ModelReader, UsageReader } from './oar-reader-contract.js';
export declare const grokListModels: ModelReader;
export declare const grokAccountUsage: UsageReader;
export declare const antigravityListModels: ModelReader;
export declare const cursorListModels: ModelReader;
// Self-contained: the build copies this declaration to dist for the private `#byok-acp-runtime` import.
export declare class AcpError extends Error {
  readonly kind: 'timeout' | 'process_exited' | 'startup_directory';
  readonly exitCode: number | null;
  readonly method: string | null;
  readonly timeoutMs: number | null;
}
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
export interface AcpControl {
  // ControlResult also permits an exit response with a numeric or null code.
  response: { body: { kind: string; code?: string | number | null; reason?: string; failure?: string } };
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
export declare function antigravitySessionCapabilities(): { readonly steer: true };
export declare function grokSessionCapabilities(): { readonly steer: true; readonly images: true };
export declare function opencodeSessionCapabilities(installation: { kind: 'available'; via: 'executable'; command: string; version?: string }): { readonly steer?: boolean; readonly images?: boolean };

export interface RawAcpSession {
  readonly id: string;
  readonly capabilities: { readonly images: boolean };
  /** `inputId` names the prompt, so a runtime with native turns (Grok) reports its turn with that id. */
  prompt(input: string, options?: RuntimeInputOptions): Promise<AcpControl>;
  /** Held by the session until the active turn (also the runtime's own) closes, then sent as a prompt carrying `inputId`. */
  queue(input: string, options?: RuntimeInputOptions): Promise<AcpControl>;
  /** Takes held input back before it is sent; `not_queued` once the drain sent it. Every vendored ACP session has it. */
  withdraw?(inputId: string): Promise<AcpControl>;
  steer?(input: string, options?: RuntimeInputOptions): Promise<AcpControl>;
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
    /** OAR SessionOptions.retainedBytes: past it the kernel elides the oldest native payloads. */
    retainedBytes: number;
    resume?: string;
    model?: string;
    effort?: string;
    /** OAR SessionOptions.appendSystemPrompt: session-local instructions added to the runtime's built-in ones. */
    appendSystemPrompt?: string;
    /** OAR SessionOptions.launchArgs: joined to the profile's argv where the profile places them. */
    launchArgs?: readonly string[];
    /** OAR SessionOptions.mcpServers: the ACP `mcpServers` of session/new and session/resume. */
    mcpServers?: readonly (
      | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
      | { readonly name: string; readonly type: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly origin?: "serveMcpTools" }
    )[];
  },
  hooks?: {
    credentialsForRedaction?: readonly string[];
    startupSignal?: AbortSignal;
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
/** BYOK's Cursor profile uses existing CLI login and refuses hosted terminals. */
export type StartCursorAcpSession = (
  spawn: Parameters<StartAcpSession>[0],
  installation: Parameters<StartAcpSession>[2],
  options: Parameters<StartAcpSession>[3],
  hooks?: Parameters<StartAcpSession>[4],
) => ReturnType<StartAcpSession>;
export declare const cursorSession: StartCursorAcpSession;

export declare class SessionUnavailableError extends Error {
  readonly name: 'SessionUnavailableError';
  readonly sessionId: string;
  readonly reason: 'archived' | 'in_use';
  readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };
  constructor(sessionId: string, message: string, details: { readonly reason: 'archived' | 'in_use'; readonly method: string; readonly native: Readonly<Record<string, unknown>> });
}
