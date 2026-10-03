import { describe, expect, it } from 'vitest';
import { CloudDoError } from '../src/errors';
import { RollingLeakGuard } from '../src/leak-guard';

const KEY = 'sk-proj-~~~Alpha~beta_0123456789+Tail/Z9';
const SENSITIVE = KEY.slice('sk-proj-'.length);

function percent(text: string, variant: 'lower' | 'upper' | 'mixed', literals = false): string {
  return Array.from(text, (character, index) => {
    if (literals && index % 3 === 0) return character;
    const hex = character.charCodeAt(0).toString(16).padStart(2, '0');
    return '%' + (variant === 'upper' || (variant === 'mixed' && index % 2 === 0)
      ? hex.toUpperCase() : hex);
  }).join('');
}

function urlSafe(encoded: string): string {
  return encoded.replace(/\+/g, '-').replace(/\//g, '_');
}

function encodings(secret: string): { name: string; text: string }[] {
  const encoded = btoa(secret);
  const result = [
    { name: 'raw', text: secret },
    { name: 'base64 padded', text: encoded },
    { name: 'base64 unpadded', text: encoded.replace(/=+$/, '') },
    { name: 'url-safe padded', text: urlSafe(encoded) },
    { name: 'url-safe unpadded', text: urlSafe(encoded).replace(/=+$/, '') },
    { name: 'percent lower', text: percent(secret, 'lower') },
    { name: 'percent upper', text: percent(secret, 'upper') },
    { name: 'percent mixed hex case', text: percent(secret, 'mixed') },
    { name: 'mixed raw and percent lower', text: percent(secret, 'lower', true) },
    { name: 'mixed raw and percent upper', text: percent(secret, 'upper', true) },
    { name: 'mixed raw and percent mixed hex case', text: percent(secret, 'mixed', true) },
  ];
  for (let offset = 0; offset < 3; offset++) {
    const surrounded = btoa('\xff'.repeat(offset) + secret + '\xff\xff');
    result.push(
      { name: `base64 in larger input offset ${offset}`, text: surrounded },
      { name: `url-safe in larger input offset ${offset}`, text: urlSafe(surrounded) },
    );
  }
  return result;
}

function assertRejected(key: string, chunks: string[]): void {
  const guard = new RollingLeakGuard(key);
  let released = '';
  let rejection: unknown;
  try {
    for (const chunk of chunks) released += guard.push(chunk);
    released += guard.finish();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(CloudDoError);
  expect((rejection as CloudDoError).code).toBe('CLOUD_MODEL_RESPONSE_REJECTED');
  expect(released).toBe('');
  expect(() => guard.finish()).toThrow(CloudDoError);
}

describe('RollingLeakGuard: decoded text before pi intake', () => {
  for (const { name, text } of encodings(KEY)) {
    it(`rejects ${name} across every split position`, () => {
      for (let split = 0; split <= text.length; split++) {
        assertRejected(KEY, [text.slice(0, split), text.slice(split)]);
      }
    });

    it(`rejects ${name} sent one character at a time`, () => {
      assertRejected(KEY, Array.from(text));
    });
  }

  it('covers every sensitive 16-character window and every encoded form/alignment', () => {
    for (let start = 0; start <= SENSITIVE.length - 16; start++) {
      const fragment = SENSITIVE.slice(start, start + 16);
      for (const { text } of encodings(fragment)) assertRejected(KEY, Array.from(text));
    }
  });

  it('covers base64 remainders and unknown adjacent bytes in all three alignments', () => {
    for (const length of [16, 17, 18, 31, 32, 33]) {
      const key = 'A4z~_/+B9'.repeat(4).slice(0, length);
      for (const prefix of ['', '\0', '\xff', '\0\0', '\xff\xff']) {
        for (const suffix of ['', '\0', '\xff', '\0\0', '\xff\xff']) {
          const encoded = btoa(prefix + key + suffix);
          for (const text of [encoded, encoded.replace(/=+$/, ''), urlSafe(encoded)]) {
            assertRejected(key, Array.from(text));
          }
        }
      }
    }
  });

  it('includes actual standard/url-safe and padded/unpadded variants in the fixture', () => {
    expect(btoa(KEY)).toContain('+');
    expect(urlSafe(btoa(KEY))).not.toBe(btoa(KEY));
    expect(btoa(KEY)).toContain('=');
  });

  it('releases safe text incrementally before EOF and flushes the exact final tail', () => {
    const guard = new RollingLeakGuard(KEY);
    const text = 'Ordinary model response. '.repeat(40);
    let released = '';
    for (const chunk of text.match(/.{1,19}/g)!) released += guard.push(chunk);
    expect(released.length).toBe(text.length - guard.tailLength);
    expect(released.length).toBeGreaterThan(0);
    expect(released + guard.finish()).toBe(text);
  });

  it('holds the longest percent-encoded unfinished form until completion', () => {
    // A 16-character unprefixed key has no shorter sensitive candidate.
    const key = 'A1B2C3D4E5F6G7H8';
    const encoded = percent(key, 'mixed');
    const guard = new RollingLeakGuard(key);
    const safe = '!'.repeat(guard.tailLength + 20);
    const released = guard.push(safe);
    expect(released).toBe('!'.repeat(20));
    const beforeLast = guard.push(encoded.slice(0, -1));
    expect(beforeLast).toBe('!'.repeat(guard.tailLength));
    expect(() => guard.push(encoded.slice(-1))).toThrow(CloudDoError);
    expect(() => guard.finish()).toThrow(CloudDoError);
  });

  it('never releases an unfinished raw sensitive fragment before it is rejected', () => {
    const guard = new RollingLeakGuard(KEY);
    const safe = '!'.repeat(guard.tailLength + 30);
    const released = guard.push(safe);
    expect(released).toBe('!'.repeat(30));
    const partial = SENSITIVE.slice(0, 15);
    expect(guard.push(partial)).toBe('!'.repeat(partial.length));
    expect(() => guard.push(SENSITIVE[15]!)).toThrow(CloudDoError);
    expect(() => guard.finish()).toThrow(CloudDoError);
    expect(released).not.toContain(partial);
  });

  it('rejects a match wholly in the unreleased final tail', () => {
    const guard = new RollingLeakGuard(KEY);
    expect(guard.push('Final: ')).toBe('');
    expect(() => guard.push(SENSITIVE.slice(-16))).toThrow(CloudDoError);
    expect(() => guard.finish()).toThrow(CloudDoError);
  });

  it('scans and flushes a final incomplete form without claiming to reject under-16 fragments', () => {
    const guard = new RollingLeakGuard(KEY);
    const final = 'Final ordinary text; short fragment ' + SENSITIVE.slice(0, 15);
    expect(guard.push(final)).toBe('');
    expect(guard.finish()).toBe(final);
  });

  it('discards buffered text explicitly and after a rejection', () => {
    const guard = new RollingLeakGuard(KEY);
    expect(guard.push('safe pending')).toBe('');
    guard.discard();
    expect(() => guard.finish()).toThrow(CloudDoError);
    expect(() => guard.push('later')).toThrow(CloudDoError);
    const rejected = new RollingLeakGuard(KEY);
    expect(() => rejected.push(KEY)).toThrow(CloudDoError);
    expect(() => rejected.push('later')).toThrow(CloudDoError);
  });

  it('keeps errors fixed and credential-free, including stack and cause', () => {
    const guard = new RollingLeakGuard(KEY);
    try {
      guard.push(KEY);
      throw new Error('Expected response rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudDoError);
      const rejected = error as CloudDoError;
      expect(rejected.message).toBe('CLOUD_MODEL_RESPONSE_REJECTED');
      expect(rejected.retryable).toBe(false);
      expect(rejected.cause).toBeUndefined();
      expect(rejected.stack).not.toContain(KEY);
      expect(JSON.stringify(rejected)).not.toContain(KEY);
    }
  });

  it('has no false positives for generic prefixes, ordinary text, or escaped regex characters', () => {
    for (const key of [KEY, 'zai-Alpha.beta~gamma+12345', 'zai_Alpha.beta~gamma+12345', 'sk-ant-Alpha.beta~gamma+12345']) {
      const guard = new RollingLeakGuard(key);
      const clean = 'sk- sk-proj- sk-ant- zai- zai_ AlphaXbeta~gamma+ prose %ff %1A ';
      expect(guard.push(clean) + guard.finish()).toBe(clean);
    }
  });

  it('strips only recognized generic prefixes from sensitive-window candidates', () => {
    const tail = 'ABCDabcd12345678';
    for (const prefix of ['sk-', 'sk-ant-', 'sk-proj-', 'zai-', 'zai_']) {
      const key = prefix + tail;
      const clean = key.slice(0, 16);
      const guard = new RollingLeakGuard(key);
      expect(guard.push(clean) + guard.finish()).toBe(clean);
      assertRejected(key, [tail]);
    }
  });

  it('bounds the maximum 512-character-key tail to 1535 and preserves clean Unicode text', () => {
    const key = 'Ab9~+/-_'.repeat(64);
    const guard = new RollingLeakGuard(key);
    expect(key).toHaveLength(512);
    expect(guard.tailLength).toBe(1535);
    const text = '你好🙂 ordinary model text. '.repeat(100);
    const released = guard.push(text);
    expect(released).toHaveLength(text.length - 1535);
    expect(released + guard.finish()).toBe(text);
    assertRejected(key, [percent(key, 'upper')]);
  });
});
