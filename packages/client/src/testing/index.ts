import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { HermesAdapter } from '../adapters/hermes/hermes-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { buildRuntimeEnvironment } from '../runtime/environment';
import type {
  RuntimeAdapter,
  RuntimeAdapterDescriptor,
  RuntimeAdapterPrepareInput,
  RuntimeAdapterPrepareResult,
  RuntimeDetectResult,
} from '../types';

/** The built-in adapters a fake can stand in for. */
export type FakeRuntimeAdapterId = 'claude' | 'codex' | 'grok' | 'hermes' | 'pi';

/** What the fake does. It never spawns a process. */
export interface FakeRuntimeAdapterBehavior {
  /** Default: `{ kind: 'available' }`. A function is called on every probe. */
  readonly detect?: RuntimeDetectResult | ((signal?: AbortSignal) => Promise<RuntimeDetectResult>);
  /** Default: a non-retryable reject, so a fake starts nothing the test did not supply. */
  readonly prepare?: (input: RuntimeAdapterPrepareInput) => Promise<RuntimeAdapterPrepareResult>;
  /** Default: the `allowlist` runtime environment, which takes no login-shell snapshot. */
  readonly runtimeEnvironment?: () => Promise<Record<string, string>>;
}

/** The real adapter's default descriptor. Construction reads no file and spawns nothing. */
function realDescriptor(id: FakeRuntimeAdapterId): RuntimeAdapterDescriptor {
  switch (id) {
    case 'claude': return new ClaudeAdapter().descriptor;
    case 'codex': return new CodexAdapter().descriptor;
    case 'grok': return new GrokAdapter().descriptor;
    case 'hermes': return new HermesAdapter({ home: path.join(os.tmpdir(), 'byok-fake-hermes') }).descriptor;
    case 'pi': return new PiAdapter().descriptor;
    default: throw new TypeError(`unknown runtime adapter id: ${String(id)}`);
  }
}

/**
 * A runtime adapter double whose descriptor is the real adapter's default
 * descriptor, so its capabilities, selection target and platforms follow the
 * SDK. Only `detect`, `prepare` and `runtimeEnvironment` are the test's.
 */
export function fakeRuntimeAdapter(id: FakeRuntimeAdapterId, behavior: FakeRuntimeAdapterBehavior = {}): RuntimeAdapter {
  const descriptor = realDescriptor(id);
  const { detect, prepare, runtimeEnvironment } = behavior;
  return Object.freeze({
    descriptor,
    runtimeEnvironment: runtimeEnvironment ?? (() => buildRuntimeEnvironment({ base: 'allowlist' })),
    detect: async (signal?: AbortSignal) => typeof detect === 'function' ? detect(signal) : detect ?? { kind: 'available' },
    prepare: async (input: RuntimeAdapterPrepareInput): Promise<RuntimeAdapterPrepareResult> => prepare === undefined
      ? { kind: 'reject', reason: `fake ${id} adapter has no prepare behavior`, retryable: false }
      : prepare(input),
  });
}
