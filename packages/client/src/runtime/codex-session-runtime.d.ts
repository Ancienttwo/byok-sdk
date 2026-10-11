import type { CodexRecord } from '../adapters/codex/projection';
import type { spawnOwnedLineProcess } from './owned-line-process';
export interface CodexControl {
  // ControlResult also permits an exit response with a numeric or null code.
  response: { body: { kind: string; code?: string | number | null; reason?: string } };
}
/** OAR 0.25.0 Codex always implements steer. The bridge retains this required member. */
export interface RawCodexSession {
  readonly id: string;
  prompt(input: string): Promise<CodexControl>;
  steer(input: string): Promise<CodexControl>;
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
    resume?: string;
    model?: string;
    approvalPolicy?: "never" | "on-request";
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access" | "inherit";
    /** OAR SessionOptions.mcpServers: the thread/start or thread/resume `mcp_servers` config. */
    mcpServers?: readonly (
      | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
      | { readonly name: string; readonly type: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>> }
    )[];
  },
  timeout?: number,
  hooks?: {
    onReady?: (threadId: string) => void;
    onRecord?: (record: CodexRecord) => void;
    maxBytes?: number;
    onLimit?: () => never;
    onServerRequest?: (id: string | number, method: string, params: Record<string, unknown>, reply: {
      respond(value: Record<string, unknown>): Promise<void>; reject(code: number, message: string): Promise<void>; cancelled(): void;
    }) => void;
  },
): Promise<RawCodexSession>;
