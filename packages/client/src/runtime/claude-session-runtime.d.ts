import type { spawnOwnedLineProcess } from './owned-line-process';
/** Structural SPI: one complete kernel record of a Claude stream-json session. */
export interface ClaudeRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly agentPath: readonly string[];
  readonly kind: string;
  readonly body: unknown;
}
export interface ClaudeControl {
  // ControlResult also permits an exit response with a numeric or null code.
  response: { body: { kind: string; code?: string | number | null; reason?: string } };
}
/** The vendored stream-json AdapterSession, narrowed to what the SDK calls. Claude `steer` stays off. */
export interface RawClaudeSession {
  readonly id: string;
  prompt(input: string): Promise<ClaudeControl>;
  abort(): Promise<ClaudeControl>;
  records(): readonly ClaudeRecord[];
  dispose(): Promise<void>;
}
/** Claude's projection profile and fold state: opaque to the SDK, which reads native frames from the records. */
export interface ClaudeProjectionProfile { readonly name: string }
export interface ClaudeProjectionState { readonly abortRequested: boolean }
export declare const claudeProjectionProfile: ClaudeProjectionProfile;
export declare const initialClaudeProjection: ClaudeProjectionState;
export declare const resumedClaudeProjection: ClaudeProjectionState;
/** One per open: the session's explicit credentials, redacted from records and errors. */
export interface ClaudeCredentialRedactor {
  values(this: void): readonly string[];
  add(this: void, value: string | undefined): void;
  redact(this: void, text: string): string;
  redactValue<T>(this: void, value: T): T;
}
export declare function sessionCredentialRedactor(options: {
  env?: Readonly<Record<string, string>>;
  mcpServers?: readonly { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }[];
}): ClaudeCredentialRedactor;
export interface ClaudeSessionProfile {
  readonly projection: ClaudeProjectionProfile;
  readonly initial: ClaudeProjectionState;
  readonly capabilities: { readonly queue: { readonly durable: false }; readonly attribution: 'attributed'; readonly images: false };
  readonly steer: false;
  /** Private control responses are consumed before the fold records them. */
  readonly consume: (message: Record<string, unknown>) => boolean;
  readonly open: () => Promise<void>;
  readonly exited: (code: number | null) => void;
  readonly disposing: () => void;
}
export interface ClaudeSessionHooks {
  /** Registered before any record is appended. */
  onRecord?: (record: ClaudeRecord) => void;
  /** Every runtime request, whatever its type; one the hook never answers stays unanswered. */
  onAppRequest?: (request: { readonly id: string; readonly type: string; readonly native: Record<string, unknown> }, respond: (reply: Record<string, unknown>) => Promise<void>) => void;
  /** Runs before the native interrupt is written; a throw rejects the abort and writes nothing. */
  beforeInterrupt?: () => void;
}
export declare function streamJsonSession(
  child: ReturnType<typeof spawnOwnedLineProcess>,
  sessionId: string,
  credentials: ClaudeCredentialRedactor,
  profile: ClaudeSessionProfile,
  hooks?: ClaudeSessionHooks,
): Promise<RawClaudeSession>;
