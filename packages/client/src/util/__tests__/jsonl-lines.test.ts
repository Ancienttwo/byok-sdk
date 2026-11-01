import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, test } from 'vitest';

import { createJsonlLineDecoder, readJsonlLines } from '../jsonl-lines';

const collect = (maxLineBytes?: number) => {
  const lines: string[] = [];
  let overflowed = 0;
  const decoder = createJsonlLineDecoder({
    onLine: line => lines.push(line),
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
    onOverflow: () => { overflowed += 1; },
  });
  return { decoder, lines, overflowed: () => overflowed };
};

// JSON.stringify leaves both separators raw inside strings.
const SEPARATED = JSON.stringify({ type: 'start', id: 'a b c' });

describe('jsonl line decoder', () => {
  test('splits on LF only, strips one trailing CR and skips empty lines', () => {
    const { decoder, lines } = collect();
    decoder.push('{"a":1}\r\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('keeps U+2028 and U+2029 inside one frame', () => {
    expect(SEPARATED).toContain(' ');
    const { decoder, lines } = collect();
    decoder.push(`${SEPARATED}\n`);
    expect(lines).toEqual([SEPARATED]);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'start', id: 'a b c' });
  });

  test('reassembles a multi-byte character split across chunks', () => {
    const { decoder, lines } = collect();
    const bytes = Buffer.from(`${SEPARATED}\n`, 'utf8');
    const cut = bytes.indexOf(Buffer.from(' ', 'utf8')) + 1;
    decoder.push(bytes.subarray(0, cut));
    expect(decoder.pendingBytes).toBe(cut);
    decoder.push(bytes.subarray(cut));
    expect(lines).toEqual([SEPARATED]);
    expect(decoder.pendingBytes).toBe(0);
  });

  test('holds an unterminated tail and reports its bytes', () => {
    const { decoder, lines } = collect();
    decoder.push('{"a":1}\n{"b"');
    expect(lines).toEqual(['{"a":1}']);
    expect(decoder.pendingBytes).toBe(4);
  });

  test('stops at a line over its byte budget, counting held bytes', () => {
    const { decoder, lines, overflowed } = collect(8);
    decoder.push('12345678\n1234');
    decoder.push('56789\n{"late":1}\n');
    expect(lines).toEqual(['12345678']);
    expect(overflowed()).toBe(1);
    expect(decoder.pendingBytes).toBe(0);
  });

  test('stop drops held bytes and every later chunk', () => {
    const { decoder, lines } = collect();
    decoder.push('{"a"');
    decoder.stop();
    decoder.push(':1}\n{"b":2}\n');
    expect(lines).toEqual([]);
    expect(decoder.pendingBytes).toBe(0);
  });
});

describe('readJsonlLines', () => {
  test('delivers a frame readline would split at U+2028/U+2029 (pi-durable-host stdin)', async () => {
    // The regression: readline turns one valid frame into three invalid ones.
    const viaReadline: string[] = [];
    const legacy = new PassThrough();
    const rl = createInterface({ input: legacy, crlfDelay: Infinity });
    rl.on('line', line => viaReadline.push(line));
    legacy.end(`${SEPARATED}\n`);
    await new Promise<void>(resolve => rl.once('close', resolve));
    expect(viaReadline).toHaveLength(3);

    const input = new PassThrough();
    const seen: string[] = [];
    const reader = readJsonlLines(input, line => seen.push(line));
    input.end(`${SEPARATED}\n{"type":"close","id":"2"}\n`);
    await reader.closed;
    expect(seen.map(line => JSON.parse(line))).toEqual([
      { type: 'start', id: 'a b c' },
      { type: 'close', id: '2' },
    ]);
  });

  test('close stops delivery and resolves closed before the stream ends', async () => {
    const input = new PassThrough();
    const seen: string[] = [];
    const reader = readJsonlLines(input, line => { seen.push(line); reader.close(); });
    input.write('{"n":1}\n{"n":2}\n');
    await reader.closed;
    input.write('{"n":3}\n');
    expect(seen).toEqual(['{"n":1}']);
  });
});
