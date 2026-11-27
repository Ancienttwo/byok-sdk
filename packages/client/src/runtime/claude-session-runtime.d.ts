import type { RuntimeInputOptions } from '../types.js';
import type { spawnOwnedLineProcess } from './owned-line-process.js';
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
export declare function claudeSessionCapabilities(): { readonly steer: true; readonly images: true };

export declare function claudeServiceTierSettings(requested: string | undefined): Record<string, unknown>;
export declare function claudeServiceTierRefusal(requested: string, answer: Record<string, unknown>, fallback?: 'default'): string | null;
export declare function claudeServiceTierEvents(message: Record<string, unknown>): readonly unknown[];

export interface RawClaudeSession {
  readonly id: string;
  readonly capabilities: { readonly images: boolean };
  prompt(input: string, options?: RuntimeInputOptions): Promise<ClaudeControl>;
  /** Input for after the turn Claude runs on its own; OAR holds it and sends it when that turn ends. */
  queue(input: string, options?: RuntimeInputOptions): Promise<ClaudeControl>;
  /** Takes a held input back before OAR sends it; `not_queued` once it was sent. The stream-json session always has it. */
  withdraw?(inputId: string): Promise<ClaudeControl>;
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
interface ClaudeCredentialRedactionTail {
  readonly text: string;
  readonly covered: number;
  readonly continuesRedaction: boolean;
}

/** One per open: the session's explicit credentials, redacted from records and errors. */
export interface ClaudeCredentialRedactor {
  values(this: void): readonly string[];
  hasProtectedValues(this: void): boolean;
  matches(this: void, text: string): boolean;
  redactChunk(this: void, text: string, tail?: ClaudeCredentialRedactionTail): { readonly ready: string; readonly pending?: ClaudeCredentialRedactionTail };
  finishRedaction(this: void, tail?: ClaudeCredentialRedactionTail): string;
  add(this: void, value: string | undefined): void;
  addExplicit(this: void, value: string): void;
  addImage(this: void, data: string): void;
  redact(this: void, text: string): string;
  redactValue<T>(this: void, value: T, jsonField?: (path: readonly (string | number)[]) => boolean, structure?: {
    readonly string: (path: readonly (string | number)[], value: string) => boolean;
    readonly keys: (path: readonly (string | number)[], key: string) => boolean;
  }): T;
}
export declare function sessionCredentialRedactor(options: {
  env?: Readonly<Record<string, string>>;
  mcpServers?: readonly (
    | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
    | { readonly name: string; readonly type: 'http'; readonly url: string; readonly headers?: Readonly<Record<string, string>> }
  )[];
}): ClaudeCredentialRedactor;
export interface ClaudeSessionProfile {
  readonly projection: ClaudeProjectionProfile;
  readonly initial: ClaudeProjectionState;
  readonly capabilities: { readonly queue: { readonly durable: false }; readonly attribution: 'attributed'; readonly images: true };
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
  onSessionInit?: (sessionId: string) => void;
  onRequestCancelled?: (requestId: string) => void;
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
  /** Retained-record budget: past it the oldest frame payloads are elided; the session keeps running. */
  retainedBytes?: number,
): Promise<RawClaudeSession>;
