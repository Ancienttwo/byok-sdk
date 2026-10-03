import type { CodexRecord } from '../adapters/codex/projection';
import type { spawnOwnedLineProcess } from './owned-line-process';
export interface CodexControl {
  response: { body: { kind: string; code?: string; reason?: string } };
}
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
  },
  timeout?: number,
  hooks?: {
    onReady?: (threadId: string) => void;
    onRecord?: (record: CodexRecord) => void;
    maxBytes?: number;
    onLimit?: () => never;
  },
): Promise<RawCodexSession>;
