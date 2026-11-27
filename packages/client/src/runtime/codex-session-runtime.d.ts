import type { RuntimeInputOptions } from '../types';
import type { OarFailureClass } from './oar-failure-runtime';
import type { CodexRecord } from '../adapters/codex/projection';
import type { spawnOwnedLineProcess } from './owned-line-process';
import type { ProcessTable } from './oar-process-tree';
export interface CodexControl {
  // ControlResult also permits an exit response with a numeric or null code.
  response: { body: { kind: string; code?: string | number | null; reason?: string } };
}
export declare function startAppServerClient(
  spawn: typeof spawnOwnedLineProcess, command: string, env: Readonly<Record<string, string>>,
  configOverrides?: Readonly<Record<string, string>>, cwd?: string, options?: { readonly launchArgs?: readonly string[]; readonly redact?: (text: string) => string },
): {
  readonly spawned: Promise<void>;
  handle(handlers: { onNotification(): void; onServerRequest(): void }): void;
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params: Record<string, unknown>): void;
  kill(): void;
};
/** OAR 0.25.0 Codex always implements steer. The bridge retains this required member. */
export declare function codexSessionCapabilities(): { readonly steer: true; readonly images: true };

export interface RawCodexSession {
  readonly id: string;
  readonly capabilities: { readonly images: boolean };
  prompt(input: string, options?: RuntimeInputOptions): Promise<CodexControl>;
  steer(input: string, options?: RuntimeInputOptions): Promise<CodexControl>;
  queue(input: string, options?: RuntimeInputOptions): Promise<CodexControl>;
  abort(): Promise<CodexControl>;
  records(): readonly CodexRecord[];
  dispose(): Promise<void>;
}
/** A resume of a missing native conversation: the vendored typed error, never matched by name or message. */
export declare class SessionNotFoundError extends Error {
  readonly name: 'SessionNotFoundError';
  readonly sessionId: string;
  readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };
  constructor(sessionId: string, message: string, cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> });
}
export declare function codexSession(
  spawn: typeof spawnOwnedLineProcess,
  installation: { kind: 'available'; via: 'executable'; command: string },
  options: {
    cwd: string;
    env: Readonly<Record<string, string>>;
    /** OAR SessionOptions.retainedBytes: past it the kernel elides the oldest native payloads. */
    retainedBytes: number;
    endTurnProcessesOnAbort?: boolean;
    resume?: string;
    model?: string;
    effort?: string;
    approvalPolicy?: "never" | "on-request";
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access" | "inherit";
    /** OAR SessionOptions.launchArgs: host `app-server` arguments after the sandbox override and before `--listen`. */
    launchArgs?: readonly string[];
    /** OAR SessionOptions.mcpServers: the thread/start or thread/resume `mcp_servers` config. */
    mcpServers?: readonly (
      | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
      | { readonly name: string; readonly type: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>>; readonly origin?: "serveMcpTools" }
    )[];
  },
  timeout?: number,
  hooks?: {
    onReady?: (threadId: string) => void;
    turnProcessReader?: { rootPid(): number | undefined; readProcessTable(): ProcessTable };
    onRecord?: (record: CodexRecord) => void;
    onNativeIdentity?: (method: string, identity: Record<string, unknown>) => void;
    onServerRequest?: (id: string | number, method: string, params: Record<string, unknown>, reply: {
      respond(value: Record<string, unknown>, freeTextAnswers?: ReadonlyMap<string, string>): Promise<void>;
      reject(code: number, message: string): Promise<void>; cancelled(): void;
    }) => void;
    /** Runs on the session's own app-server client before the thread open; returns the open request params. A throw kills the app-server. */
    beforeOpen?: (request: CodexOpenStepRequest, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    /** Runs on the same client after the open reply's read-back, before `onReady`. A throw kills the app-server. */
    afterOpen?: (request: CodexOpenStepRequest, threadId: string) => Promise<void>;
  },
): Promise<RawCodexSession>;
/** One request on the session's own app-server client. */
export type CodexOpenStepRequest = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export declare class SessionUnavailableError extends Error {
  readonly name: 'SessionUnavailableError';
  readonly sessionId: string;
  readonly reason: 'archived' | 'in_use';
  readonly cause: { readonly method: string; readonly native: Readonly<Record<string, unknown>> };
  constructor(sessionId: string, message: string, details: { readonly reason: 'archived' | 'in_use'; readonly method: string; readonly native: Readonly<Record<string, unknown>> });
}
export declare class RuntimeFailureError extends Error {
  readonly name: 'RuntimeFailureError';
  readonly failure: OarFailureClass;
  readonly code?: 'project_packages_blocked' | 'runtime_outdated' | 'runtime_config_invalid';
  readonly credential?: 'missing' | 'rejected';
  readonly status?: number;
  readonly reason: string;
}
export declare class UnsupportedOptionError extends Error {
  readonly name: string;
  readonly option: 'modelRequests' | 'retainedBytes' | 'goals' | 'endTurnProcessesOnAbort' | 'cwd' | 'additionalDirectories' | 'model' | 'effort' | 'serviceTier' | 'serviceTierFallback' | 'userQuestions' | 'outputSchema' | 'name' | 'resume' | 'fork' | 'env' | 'userConfiguration' | 'systemPrompt' | 'appendSystemPrompt' | 'mcpServers' | 'disallowedTools' | 'launchArgs' | 'nativeMemoryDefault' | 'sessionLogUpload' | 'nativePermissions' | 'placement';
}
/** The open could not confirm the requested model from the runtime's readback: the vendored typed error. */
export declare class ModelConfirmationError extends Error {
  readonly name: 'ModelConfirmationError';
  readonly requested: string;
  readonly reported: string | null;
  readonly catalogSelectorIds?: readonly string[];
}
