/** The prepared host's first-frame handling: bounded LF framing and the exact `prompt_prepared` shape. */
import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { parsePreparedPromptCommand, readFirstJsonlFrame } from '../prepared-prompt-frame';

describe('readFirstJsonlFrame', () => {
  test('returns the first LF-terminated frame across chunks and leaves the rest unread and paused', async () => {
    const stream = new PassThrough();
    const pending = readFirstJsonlFrame(stream, 1024);
    stream.write(Buffer.from('{"a":"你'));
    stream.write(Buffer.from('好"}\r\n{"next":1}\n'));
    await expect(pending).resolves.toBe('{"a":"你好"}');
    expect(stream.isPaused()).toBe(true);
    const rest: string[] = [];
    stream.on('data', (chunk: Buffer) => rest.push(chunk.toString('utf8')));
    stream.resume();
    await new Promise((resolve) => setImmediate(resolve));
    expect(rest.join('')).toBe('{"next":1}\n');
  });

  test('refuses a frame above the bound, with or without its LF', async () => {
    const unterminated = new PassThrough();
    const tooLong = readFirstJsonlFrame(unterminated, 8);
    unterminated.write('0123456789');
    await expect(tooLong).rejects.toThrow(/exceeds the 8-byte frame limit/u);

    const terminated = new PassThrough();
    const tooLongWithLf = readFirstJsonlFrame(terminated, 8);
    terminated.write('01234567\n');
    await expect(tooLongWithLf).rejects.toThrow(/exceeds the 8-byte frame limit/u);
  });

  test('refuses an input that ends before a complete frame', async () => {
    const stream = new PassThrough();
    const pending = readFirstJsonlFrame(stream, 1024);
    stream.end('{"partial":');
    await expect(pending).rejects.toThrow(/ended before a complete first frame/u);
  });
});

describe('parsePreparedPromptCommand', () => {
  test('admits exactly id, type, input and expected', () => {
    expect(parsePreparedPromptCommand('{"id":"prepared-1","type":"prompt_prepared","input":{},"expected":{}}'))
      .toEqual({ id: 'prepared-1', input: {}, expected: {} });
  });

  test.each([
    ['not json', undefined, /not JSON/u],
    ['[]', undefined, /not an object/u],
    ['{"id":"x","type":"prompt","message":"hi"}', 'x', /must be prompt_prepared/u],
    ['{"id":"x","type":"prompt_prepared","input":{},"expected":{},"extra":1}', 'x', /accepts only/u],
    ['{"type":"prompt_prepared","input":{},"expected":{}}', undefined, /non-empty id/u],
    ['{"id":"x","type":"prompt_prepared","input":[],"expected":{}}', 'x', /object "input"/u],
  ])('refuses %s', (line, id, pattern) => {
    const parsed = parsePreparedPromptCommand(line);
    expect('error' in parsed && parsed.error).toMatch(pattern);
    expect(parsed.id).toBe(id);
  });
});
