import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import {
  PolicyUnsupportedError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeDetectResult,
  type Session,
  type TaskContext,
} from '../../types';
import { resolvePiBin, type ResolvedBin } from './resolve-bin';
import { mapPermissionPolicyToPiArgs } from './permission-mapping';
import { mapPiMessageToAgentEvent } from './events';
import { PiRpcClient, type SpawnFn } from './rpc-client';

const execFileAsync = promisify(execFile);

/**
 * Known provider credential env var *names* (never values) — see the
 * credential-isolation rule on `RuntimeAdapter`. `detect()` only checks
 * whether one of these names is set; it never reads pi's own auth storage
 * (`~/.pi/...`) or any file contents. Not exhaustive (pi supports ~30
 * providers); covers the common ones for a useful `authPresent` signal.
 */
const KNOWN_PROVIDER_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
] as const;

export interface PiAdapterOptions {
  /** Override bin resolution — tests substitute the fake-pi fixture script. */
  resolveBin?: () => ResolvedBin;
  /** Override process spawning — tests substitute a fake spawn. */
  spawnFn?: SpawnFn;
}

export class PiAdapter implements RuntimeAdapter {
  readonly id = 'pi';

  constructor(private readonly options: PiAdapterOptions = {}) {}

  async detect(): Promise<RuntimeDetectResult> {
    const bin = this.resolveBin();
    try {
      // Empirically, pi (0.74.2 and 0.80.7) prints `--version` output to
      // STDERR, not stdout — confirmed with an explicit stdout/stderr probe,
      // not assumed. Check both so this doesn't silently regress if a future
      // pi release moves it back to stdout.
      const { stdout, stderr } = await execFileAsync(bin.command, ['--version']);
      const version = stdout.trim() || stderr.trim();
      const authPresent = KNOWN_PROVIDER_ENV_VARS.some((name) => process.env[name] !== undefined);
      return { present: true, version, authPresent };
    } catch {
      return { present: false };
    }
  }

  capabilities(): RuntimeCapabilities {
    return { steer: true, resume: true, permissionModes: ['auto', 'readonly'] };
  }

  async start(task: TaskOfferPayload, ctx: TaskContext): Promise<Session> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('pi adapter only supports string instructions in M0 (no blob-ref fetch yet)');
    }

    const mapping = mapPermissionPolicyToPiArgs(ctx.policy);
    if (!mapping.ok) {
      throw new PolicyUnsupportedError(mapping.reason ?? 'policy rejected by pi adapter');
    }

    const bin = this.resolveBin();
    // sessionRef doubles as pi's own `--session-id`: a follow-up offer
    // carrying a previously-reported sessionRef resumes that exact pi
    // session; a fresh task mints a new id up front so `sessionRef` is known
    // before any event streams back.
    const sessionRef = task.sessionRef ?? crypto.randomUUID();
    const args = ['--mode', 'rpc', '--session-id', sessionRef, ...mapping.args];

    const rpc = new PiRpcClient({
      command: bin.command,
      args,
      cwd: ctx.workspaceDir,
      env: ctx.env,
      spawnFn: this.options.spawnFn,
    });

    const response = await rpc.send({ type: 'prompt', message: task.instruction });
    if (response.success === false) {
      rpc.kill();
      throw new Error(typeof response.error === 'string' ? response.error : 'pi rejected the initial prompt');
    }

    return new PiSession(sessionRef, rpc);
  }

  private resolveBin(): ResolvedBin {
    return (this.options.resolveBin ?? resolvePiBin)();
  }
}

class PiSession implements Session {
  constructor(
    public readonly sessionRef: string,
    private readonly rpc: PiRpcClient,
  ) {}

  get events(): AsyncIterable<AgentEvent> {
    const rpc = this.rpc;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        const inner = rpc.events[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            for (;;) {
              const { value, done } = await inner.next();
              if (done) return { value: undefined as never, done: true };
              const mapped = mapPiMessageToAgentEvent(value);
              if (mapped) return { value: mapped, done: false };
              // Unmapped pi message (compaction/retry bookkeeping, extension
              // UI dialogs) — keep pulling instead of surfacing it.
            }
          },
        };
      },
    };
  }

  async steer(text: string): Promise<void> {
    await this.rpc.send({ type: 'steer', message: text });
  }

  async followUp(task: TaskOfferPayload): Promise<void> {
    if (typeof task.instruction !== 'string') {
      throw new PolicyUnsupportedError('pi adapter only supports string instructions in M0 (no blob-ref fetch yet)');
    }
    await this.rpc.send({ type: 'prompt', message: task.instruction, streamingBehavior: 'followUp' });
  }

  async interrupt(): Promise<void> {
    await this.rpc.send({ type: 'abort' });
  }

  async close(): Promise<void> {
    this.rpc.kill();
  }
}
