import { describe, expect, it } from 'vitest';
import { readThroughFirstEvent } from './sse-reader';

function readerFor(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).getReader();
}

describe('test SSE reader', () => {
  it('buffers complete frames and UTF-8 across transport chunks', async () => {
    const text = ': keepalive\n\ndata: {"type":"text_delta","delta":"字"}\n\n';
    const bytes = new TextEncoder().encode(text);
    const split = bytes.indexOf(0xe5) + 1;
    const reader = readerFor([bytes.slice(0, 13), bytes.slice(13, split), bytes.slice(split, -1), bytes.slice(-1)]);
    expect(await readThroughFirstEvent(reader)).toBe(text);
    expect(await reader.read()).toMatchObject({ done: true });
  });

  it.each([': keepalive\n\n', 'data: {"type":"text_delta"}'])('rejects EOF without a complete data frame: %s', async text => {
    await expect(readThroughFirstEvent(readerFor([new TextEncoder().encode(text)]))).rejects.toThrow('before its first complete data event');
  });

  it('keeps decoder state for a caller continuing after the first event', async () => {
    const first = 'data: {"type":"text_delta","delta":"a"}\n\n';
    const tail = 'data: {"type":"text_delta","delta":"字"}\n\n';
    const bytes = new TextEncoder().encode(first + tail);
    const split = bytes.indexOf(0xe5) + 1;
    const reader = readerFor([bytes.slice(0, split), bytes.slice(split)]);
    const decoder = new TextDecoder();
    const prefix = await readThroughFirstEvent(reader, decoder);
    const next = await reader.read();
    expect(prefix + decoder.decode(next.value, { stream: true }) + decoder.decode()).toBe(first + tail);
  });
});
