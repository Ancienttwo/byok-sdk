import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readUtf8Body } from './request-body';

// The line #1226 corrupted: 来源 is 3 bytes per code point, so transport splits land inside it.
const DOCUMENT = '可读来源名称：本次查询的公司资料截至某年某月某日。';

describe('readUtf8Body', () => {
  it('keeps code points that arrive split across two transport chunks', async () => {
    const bytes = Buffer.from(DOCUMENT, 'utf8');
    for (let split = 1; split < bytes.length; split++) {
      const body = await readUtf8Body(Readable.from([bytes.subarray(0, split), bytes.subarray(split)]));
      expect(body, `split at byte ${split}`).toBe(DOCUMENT);
    }
  });

  it('keeps a code point split at the real 8192-byte transport boundary', async () => {
    // Pad so 来 starts on byte 8192; the transport boundary one byte later splits its 3-byte sequence.
    const target = DOCUMENT.indexOf('来源');
    const prefix = 'x'.repeat(8192 - Buffer.byteLength(DOCUMENT.slice(0, target)));
    const text = prefix + DOCUMENT.slice(target);
    const bytes = Buffer.from(text, 'utf8');
    const body = await readUtf8Body(Readable.from([bytes.subarray(0, 8193), bytes.subarray(8193)]));
    expect(body).toBe(text);
    expect(body).not.toContain('\uFFFD');
  });

  it('accepts string chunks and rejects a body that is not valid UTF-8', async () => {
    expect(await readUtf8Body(Readable.from([DOCUMENT]))).toBe(DOCUMENT);
    await expect(readUtf8Body(Readable.from([Buffer.from([0x2e, 0xe6, 0x9d])]))).rejects.toThrow('Request body is not valid UTF-8 (3 bytes)');
  });
});
