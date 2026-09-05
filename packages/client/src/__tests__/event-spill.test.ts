import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, BlobRef } from '@byok-sdk/protocol';
import { AgentEventSchema } from '@byok-sdk/protocol';
import {
  DEFAULT_MAX_INLINE_EVENT_BYTES,
  MIN_MAX_INLINE_EVENT_BYTES,
  spillOversizedEvent,
  type EventSpillDeps,
} from '../daemon/event-spill';

/**
 * `spillOversizedEvent` is the daemon's only per-event size bound for the two
 * runtime-authored `AgentEvent` fields (`tool_use.input`,
 * `tool_result.output`). The invariant it exists to hold is measurable, so
 * every test here measures it rather than trusting the arithmetic: the
 * replacement event's ACTUAL `JSON.stringify` byte length is at or under the
 * cap, the blob carries exactly the bytes that were omitted, and no code
 * point is ever cut in half on the way there.
 */

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const utf8 = (value: string): number => Buffer.byteLength(value, 'utf8');

interface UploadCall {
  content: string;
  contentType: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function recordingBlobClient(options: { blobId?: string; fail?: Error } = {}) {
  const calls: UploadCall[] = [];
  const blobClient: EventSpillDeps['blobClient'] = {
    uploadArtifact: async (content, contentType, uploadOptions) => {
      calls.push({
        content: typeof content === 'string' ? content : new TextDecoder().decode(content),
        contentType,
        ...(uploadOptions?.idempotencyKey === undefined ? {} : { idempotencyKey: uploadOptions.idempotencyKey }),
        ...(uploadOptions?.signal === undefined ? {} : { signal: uploadOptions.signal }),
      });
      if (options.fail) throw options.fail;
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const ref: BlobRef = {
        blobId: options.blobId ?? 'blob_spill_1',
        contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.length,
        contentType,
      };
      return ref;
    },
  };
  return { blobClient, calls };
}

function deps(overrides: Partial<EventSpillDeps> = {}): EventSpillDeps & { calls: UploadCall[] } {
  const { blobClient, calls } = recordingBlobClient();
  return {
    maxInlineBytes: DEFAULT_MAX_INLINE_EVENT_BYTES,
    blobClient,
    taskId: 'task-spill',
    ...overrides,
    calls,
  };
}

/** The one thing this module must never get wrong, asserted the only way that proves it: measure the real bytes. */
function expectFits(event: AgentEvent, cap: number): void {
  expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThanOrEqual(cap);
}

function previewOf(event: AgentEvent, field: 'input' | 'output'): { head: string; tail: string } {
  const value = (event as unknown as Record<string, unknown>)[field];
  return (value as { preview: { head: string; tail: string } }).preview;
}

describe('spillOversizedEvent: events it must not touch', () => {
  it('returns the SAME object reference for an under-cap tool_result', async () => {
    const event: AgentEvent = { type: 'tool_result', tool: 'bash', toolCallId: 'c1', output: 'small' };
    const spilled = await spillOversizedEvent(event, deps());
    expect(spilled).toBe(event);
  });

  it.each(['progress', 'usage'] as const)('never touches a %s event even when it is huge', async (type) => {
    const event: AgentEvent = type === 'progress'
      ? { type: 'progress', text: 'x'.repeat(200_000) }
      : { type: 'usage', outputTokens: 5 };
    const d = deps({ maxInlineBytes: MIN_MAX_INLINE_EVENT_BYTES });
    const spilled = await spillOversizedEvent(event, d);
    expect(spilled).toBe(event);
    expect(d.calls).toHaveLength(0);
  });

  it('forwards an oversized event whose spillable field is absent, and logs it', async () => {
    const log = vi.fn();
    const event: AgentEvent = { type: 'tool_use', tool: 'x'.repeat(10_000) };
    const d = deps({ maxInlineBytes: MIN_MAX_INLINE_EVENT_BYTES, log });
    const spilled = await spillOversizedEvent(event, d);
    expect(spilled).toBe(event);
    expect(d.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('no input to spill');
  });

  it('forwards (and logs) an event that is over the cap independently of its spillable field, without uploading', async () => {
    const log = vi.fn();
    const event: AgentEvent = { type: 'tool_result', tool: 'x'.repeat(10_000), output: 'tiny' };
    const d = deps({ maxInlineBytes: MIN_MAX_INLINE_EVENT_BYTES, log });
    const spilled = await spillOversizedEvent(event, d);
    expect(spilled).toBe(event);
    expect(d.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('independently of its output');
  });
});

describe('spillOversizedEvent: oversized tool_result', () => {
  const output = { stdout: '第'.repeat(120_000), exitCode: 0 };
  const serialized = JSON.stringify(output);

  it('replaces output with a head/tail preview, uploads the full serialization, and stays under the cap', async () => {
    const event: AgentEvent = { type: 'tool_result', tool: 'bash', toolCallId: 'call-1', output };
    const d = deps();
    const spilled = await spillOversizedEvent(event, d);

    expect(spilled).not.toBe(event);
    expectFits(spilled, DEFAULT_MAX_INLINE_EVENT_BYTES);
    expect(AgentEventSchema.safeParse(spilled).success).toBe(true);

    // Untouched fields survive verbatim.
    expect(spilled).toMatchObject({ type: 'tool_result', tool: 'bash', toolCallId: 'call-1' });

    const { head, tail } = previewOf(spilled, 'output');
    expect(head.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
    expect(serialized.startsWith(head)).toBe(true);
    expect(serialized.endsWith(tail)).toBe(true);

    const spill = (spilled as { spill: Record<string, unknown> }).spill;
    expect(spill).toMatchObject({ field: 'output', contentType: 'application/json', totalBytes: utf8(serialized) });
    expect(spill['omittedBytes']).toBe(utf8(serialized) - utf8(head) - utf8(tail));
    expect(spill['unstoredReason']).toBeUndefined();
    expect((spill['blob'] as BlobRef).contentHash).toBe(`sha256:${sha256Hex(serialized)}`);
    expect((spill['blob'] as BlobRef).size).toBe(utf8(serialized));

    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.content).toBe(serialized);
    expect(d.calls[0]?.contentType).toBe('application/json');
  });

  it('uses a content-addressed idempotency key scoped to the task', async () => {
    const event: AgentEvent = { type: 'tool_result', tool: 'bash', output };
    const d = deps({ taskId: 'task-abc' });
    await spillOversizedEvent(event, d);
    expect(d.calls[0]?.idempotencyKey).toBe(`spill_task-abc_${sha256Hex(serialized)}`);
  });

  it('forwards the task abort signal to the upload', async () => {
    const controller = new AbortController();
    const event: AgentEvent = { type: 'tool_result', tool: 'bash', output };
    const d = deps({ signal: controller.signal });
    await spillOversizedEvent(event, d);
    expect(d.calls[0]?.signal).toBe(controller.signal);
  });

  it('splits the budget roughly in half between head and tail', async () => {
    const event: AgentEvent = { type: 'tool_result', tool: 'bash', output: 'a'.repeat(300_000) };
    const spilled = await spillOversizedEvent(event, deps());
    const { head, tail } = previewOf(spilled, 'output');
    expect(Math.abs(utf8(head) - utf8(tail))).toBeLessThanOrEqual(4);
  });
});

describe('spillOversizedEvent: oversized tool_use', () => {
  it('is symmetric with tool_result — spills input, preserves isError-free shape', async () => {
    const input = { path: '/tmp/big.txt', contents: 'z'.repeat(300_000) };
    const serialized = JSON.stringify(input);
    const event: AgentEvent = { type: 'tool_use', tool: 'write_file', toolCallId: 'call-w', input };
    const d = deps();
    const spilled = await spillOversizedEvent(event, d);

    expectFits(spilled, DEFAULT_MAX_INLINE_EVENT_BYTES);
    expect(AgentEventSchema.safeParse(spilled).success).toBe(true);
    expect(spilled).toMatchObject({ type: 'tool_use', tool: 'write_file', toolCallId: 'call-w' });
    const spill = (spilled as { spill: Record<string, unknown> }).spill;
    expect(spill['field']).toBe('input');
    expect((spill['blob'] as BlobRef).contentHash).toBe(`sha256:${sha256Hex(serialized)}`);
    expect(d.calls[0]?.content).toBe(serialized);
  });
});

describe('spillOversizedEvent: UTF-8 boundary safety', () => {
  it('never splits a multi-byte sequence or a surrogate pair at either cut', async () => {
    // CJK (3 bytes), emoji (4 bytes / surrogate pair), and a rare astral
    // character, repeated so that BOTH cuts land inside the mixed run rather
    // than on a convenient ASCII boundary.
    const unit = '漢字🙂𐍈é';
    const output = unit.repeat(40_000);
    const serialized = JSON.stringify(output);
    const event: AgentEvent = { type: 'tool_result', tool: 'cat', output };

    // Sweep caps so the cut lands at many different offsets inside the run.
    for (const maxInlineBytes of [4096, 4097, 4098, 4099, 4100, 8192, 8195, 65_536]) {
      const spilled = await spillOversizedEvent(event, deps({ maxInlineBytes }));
      expectFits(spilled, maxInlineBytes);
      const { head, tail } = previewOf(spilled, 'output');

      // A broken cut would leave a lone surrogate, which round-trips through
      // UTF-8 as U+FFFD; an intact cut round-trips byte-for-byte.
      for (const piece of [head, tail]) {
        const roundTripped = new TextDecoder().decode(new TextEncoder().encode(piece));
        expect(roundTripped).toBe(piece);
        // A high surrogate with no low after it, or a low with no high
        // before it — i.e. exactly what a mid-character cut would leave.
        expect(piece).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }
      expect(serialized.startsWith(head)).toBe(true);
      expect(serialized.endsWith(tail)).toBe(true);
      expect(JSON.parse(JSON.stringify(spilled))).toEqual(spilled);
      expect(AgentEventSchema.safeParse(spilled).success).toBe(true);
    }
  });

  it('stays under the cap even when JSON escaping inflates the preview several times over', async () => {
    // Every character costs 6 bytes once escaped (\u0001), so a byte budget
    // computed on the raw string would overshoot by ~6x if it were trusted
    // instead of measured.
    const output = '\u0001'.repeat(200_000);
    const event: AgentEvent = { type: 'tool_result', tool: 'bash', output };
    for (const maxInlineBytes of [MIN_MAX_INLINE_EVENT_BYTES, 16_384, DEFAULT_MAX_INLINE_EVENT_BYTES]) {
      const spilled = await spillOversizedEvent(event, deps({ maxInlineBytes }));
      expectFits(spilled, maxInlineBytes);
      const { head, tail } = previewOf(spilled, 'output');
      expect(utf8(head) + utf8(tail)).toBeGreaterThan(0);
    }
  });

  it('never lets head and tail overlap into duplicated content', async () => {
    // Just barely over the cap, so the full serialization is only slightly
    // longer than the preview budget — the shape where a naive head+tail
    // split would emit the middle twice.
    const output = 'q'.repeat(4200);
    const serialized = JSON.stringify(output);
    const spilled = await spillOversizedEvent(
      { type: 'tool_result', tool: 'bash', output },
      deps({ maxInlineBytes: MIN_MAX_INLINE_EVENT_BYTES }),
    );
    const { head, tail } = previewOf(spilled, 'output');
    expect(head.length + tail.length).toBeLessThanOrEqual(serialized.length);
    const spill = (spilled as { spill: Record<string, unknown> }).spill;
    expect(spill['omittedBytes']).toBe(utf8(serialized) - utf8(head) - utf8(tail));
    expect(spill['omittedBytes'] as number).toBeGreaterThanOrEqual(0);
  });
});

describe('spillOversizedEvent: storage failure', () => {
  it('reports unstoredReason (bounded), carries no blob, still fits the cap, and logs exactly once', async () => {
    const log = vi.fn();
    const { blobClient, calls } = recordingBlobClient({ fail: new Error('X'.repeat(4000)) });
    const event: AgentEvent = { type: 'tool_result', tool: 'bash', output: 'y'.repeat(300_000) };
    const spilled = await spillOversizedEvent(event, {
      maxInlineBytes: DEFAULT_MAX_INLINE_EVENT_BYTES,
      blobClient,
      taskId: 'task-fail',
      log,
    });

    expectFits(spilled, DEFAULT_MAX_INLINE_EVENT_BYTES);
    expect(AgentEventSchema.safeParse(spilled).success).toBe(true);
    const spill = (spilled as { spill: Record<string, unknown> }).spill;
    expect(spill['blob']).toBeUndefined();
    const reason = spill['unstoredReason'] as string;
    expect(utf8(reason)).toBeLessThanOrEqual(512);
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.startsWith('Error: XXX')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('could not be stored');
  });

  it('still produces a usable preview when the upload rejects', async () => {
    const { blobClient } = recordingBlobClient({ fail: new Error('HTTP 503') });
    const output = 'head-marker' + 'm'.repeat(300_000) + 'tail-marker';
    const spilled = await spillOversizedEvent(
      { type: 'tool_result', tool: 'bash', output },
      { maxInlineBytes: DEFAULT_MAX_INLINE_EVENT_BYTES, blobClient, taskId: 't' },
    );
    const { head, tail } = previewOf(spilled, 'output');
    expect(head).toContain('head-marker');
    expect(tail).toContain('tail-marker');
  });
});

describe('spillOversizedEvent: cap invariant at the configured minimum', () => {
  it('fits MIN_MAX_INLINE_EVENT_BYTES with a 200-character blobId', async () => {
    const { blobClient } = recordingBlobClient({ blobId: `blob_${'B'.repeat(195)}` });
    const event: AgentEvent = {
      type: 'tool_result',
      tool: 'shell_exec_with_a_long_runtime_specific_name',
      toolCallId: '11111111-1111-4111-8111-111111111111',
      isError: true,
      output: { stdout: '漢'.repeat(80_000), stderr: '🙂'.repeat(40_000) },
    };
    const spilled = await spillOversizedEvent(event, {
      maxInlineBytes: MIN_MAX_INLINE_EVENT_BYTES,
      blobClient,
      taskId: 'task-minimum-cap',
    });
    expectFits(spilled, MIN_MAX_INLINE_EVENT_BYTES);
    expect(AgentEventSchema.safeParse(spilled).success).toBe(true);
    const { head, tail } = previewOf(spilled, 'output');
    expect(utf8(head) + utf8(tail)).toBeGreaterThan(0);
    expect(spilled).toMatchObject({ isError: true });
  });

  it('fits MIN_MAX_INLINE_EVENT_BYTES with a maximum-length unstoredReason', async () => {
    const { blobClient } = recordingBlobClient({ fail: new Error('R'.repeat(9000)) });
    const spilled = await spillOversizedEvent(
      { type: 'tool_use', tool: 'apply_patch', input: 'p'.repeat(500_000) },
      { maxInlineBytes: MIN_MAX_INLINE_EVENT_BYTES, blobClient, taskId: 'task-minimum-cap-unstored' },
    );
    expectFits(spilled, MIN_MAX_INLINE_EVENT_BYTES);
    expect(AgentEventSchema.safeParse(spilled).success).toBe(true);
    const spill = (spilled as { spill: Record<string, unknown> }).spill;
    expect(utf8(spill['unstoredReason'] as string)).toBe(512);
  });
});
