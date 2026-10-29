import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  AgentMemoryIntentAvailablePayload,
  AgentMemoryIntentCompletion,
} from '@byok-sdk/protocol';
import type { DeviceSnapshot } from './snapshot';
import { type AgentMemoryIntentFetchInput } from '@byok-sdk/protocol';

/**
 * Wire between the device program and the independent Host (#605 W5).
 *
 * The device runs where the fault happens: a child process, or a program in a
 * guest VM that connects back over TCP. The Host runs outside the fault and
 * keeps every receipt. One message per line, each line prefixed so that other
 * output on the same stream is never parsed as a message.
 */
export const POWERCUT_LINE_PREFIX = 'W5 ';
export const POWERCUT_TENANT_ID = 'tenant-w5';
export const POWERCUT_DEVICE_ID = 'device-w5';

export type DeviceMessage =
  | { readonly type: 'snapshot'; readonly snapshot: DeviceSnapshot }
  | { readonly type: 'ready' }
  | { readonly type: 'fetch'; readonly id: number; readonly request: AgentMemoryIntentFetchInput }
  | { readonly type: 'complete'; readonly id: number; readonly completion: AgentMemoryIntentCompletion }
  | { readonly type: 'acked'; readonly intentId: string; readonly completion: AgentMemoryIntentCompletion }
  | { readonly type: 'failed'; readonly intentId: string; readonly reason: string };

export type HostMessage =
  | { readonly type: 'notice'; readonly payload: AgentMemoryIntentAvailablePayload }
  | { readonly type: 'reply'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: 'reply'; readonly id: number; readonly ok: false }
  | { readonly type: 'stop' };

/** A duplex byte link: stdio of a child, or one TCP connection from a guest. */
export interface PowercutLink {
  readonly input: Readable;
  readonly output: Writable;
}

export function writeMessage(output: Writable, message: DeviceMessage | HostMessage): void {
  output.write(`${POWERCUT_LINE_PREFIX}${JSON.stringify(message)}\n`);
}

/**
 * Yields each prefixed message. Other lines go to `other`. The iterator ends
 * when the stream closes, which is how the Host sees a cut.
 */
export async function* readMessages<T>(input: Readable, other?: (line: string) => void): AsyncGenerator<T> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.startsWith(POWERCUT_LINE_PREFIX)) yield JSON.parse(line.slice(POWERCUT_LINE_PREFIX.length)) as T;
    else other?.(line);
  }
}
