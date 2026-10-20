import type { spawnOwnedLineProcess } from './owned-line-process';
import type { spawnOwnedTerminalProcess } from './owned-terminal-process';
export { SessionNotFoundError } from './codex-session-runtime';
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
  prompt(input: string): Promise<AcpControl>;
  abort(): Promise<AcpControl>;
  records(): readonly AcpRecord[];
  dispose(): Promise<void>;
}
/** Every vendored ACP runtime start: the SDK owns the agent process, each hosted terminal process and the environment. */
export type StartAcpSession = (
  spawn: typeof spawnOwnedLineProcess,
  spawnTerminal: typeof spawnOwnedTerminalProcess,
  installation: { kind: 'available'; via: 'executable'; command: string },
  options: {
    cwd: string;
    env: Readonly<Record<string, string>>;
    resume?: string;
    model?: string;
    /** OAR SessionOptions.mcpServers: the ACP `mcpServers` of session/new and session/resume. */
    mcpServers?: readonly (
      | { readonly name: string; readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>> }
      | { readonly name: string; readonly type: "http"; readonly url: string; readonly headers?: Readonly<Record<string, string>> }
    )[];
  },
  hooks?: {
    onReady?: (sessionId: string) => void;
    onRecord?: (record: AcpRecord) => void;
    maxBytes?: number;
    onLimit?: () => never;
  },
) => Promise<RawAcpSession>;
