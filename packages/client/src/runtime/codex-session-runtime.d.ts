import type { CodexRecord } from '../adapters/codex/projection';
import type { spawnOwnedLineProcess } from './owned-line-process';
export interface CodexControl {
  // ControlResult also permits an exit response with a numeric or null code.
  response: { body: { kind: string; code?: string | number | null; reason?: string } };
}
/** OAR 0.20.3 Codex always implements steer. The bridge retains this required member. */
export interface RawCodexSession {
  readonly id: string;
  prompt(input: string): Promise<CodexControl>;
  steer(input: string): Promise<CodexControl>;
  abort(): Promise<CodexControl>;
  records(): readonly CodexRecord[];
  dispose(): Promise<void>;
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
