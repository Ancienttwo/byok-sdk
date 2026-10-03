import { describe, expect, it } from 'vitest';
import { admitCloudSubmission, hasUserKeyShape } from '../src/admission';

const KEY = 'sk-proj-User_Aa0123456789SecretKey';
describe('frozen cloud submission admission', () => {
  it('admits only instruction and one frozen profile, defaulting to zai', () => {
    expect(admitCloudSubmission({ instruction: 'Write a paragraph.' })).toEqual({ instruction: 'Write a paragraph.', profile: 'zai_openai' });
    expect(admitCloudSubmission({ instruction: 'Write a paragraph.', profile: 'deepseek_direct' })).toEqual({ instruction: 'Write a paragraph.', profile: 'deepseek_direct' });
  });
  for (const name of ['credential', 'credentials', 'apiKey', 'APIKEY', 'api_key', 'secret', 'authorization', 'Authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization', 'cf-aig-authorization', 'headers']) {
    for (const nested of [false, true]) it(`rejects ${nested ? 'nested' : 'top-level'} ${name} without echo`, () => {
      const input = { instruction: 'Write a paragraph.', ...(nested ? { metadata: { nested: [{ [name]: KEY }] } } : { [name]: KEY }) };
      expect(() => admitCloudSubmission(input)).toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
      try { admitCloudSubmission(input); } catch (error) {
        expect(error).toMatchObject({ status: 400, retryable: false });
        expect(String(error)).not.toContain(KEY);
        expect((error as Error).stack).not.toContain(KEY);
        expect((error as Error).cause).toBeUndefined();
      }
    });
  }
  for (const input of [null, [], 'text', 123, {}, { instruction: '' }, { instruction: '  ' }, { instruction: 1 }, { instruction: 'x'.repeat(16001) }, { instruction: 'ok', profile: null }, { instruction: 'ok', profile: 'other' }, { instruction: 'ok', profile: '__proto__' }, { instruction: 'ok', model: 'glm-5.3-flash' }, { instruction: 'ok', metadata: {} }, { instruction: 'ok', renamedKey: KEY }, { instruction: { text: 'ok' } }, { instruction: 'ok', baseUrl: 'https://evil.invalid' }]) {
    it(`rejects invalid or unknown shape ${JSON.stringify(input).slice(0, 100)}`, () => {
      expect(() => admitCloudSubmission(input)).toThrow('CLOUD_REQUEST_INVALID');
    });
  }
  for (const text of [KEY, 'sk-ant-UserSecret0123456789abcdef', `${'a'.repeat(32)}.Secret0123456789abcdef`]) it('rejects recognizable user credentials inside free text', () => {
    expect(hasUserKeyShape(text)).toBe(true);
    expect(() => admitCloudSubmission({ instruction: `Please use ${text}` })).toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
  });
  // Keep the current generic sk- fallback. Do not change the detector's policy.
  const formats = [
    { name: 'sk-', prefix: 'sk-', minimum: 16 },
    { name: 'sk-ant-', prefix: 'sk-ant-', minimum: 12 },
    { name: 'sk-proj-', prefix: 'sk-proj-', minimum: 11 },
    { name: '32 lower-case hex plus dot', prefix: `${'a'.repeat(32)}.`, minimum: 16 },
  ];
  for (const format of formats) {
    it(`locks the covered ${format.name} format and its current length boundary`, () => {
      const positive = format.prefix + 'x'.repeat(16);
      const boundary = format.prefix + 'x'.repeat(format.minimum);
      const negative = format.prefix + 'x'.repeat(format.minimum - 1);
      expect(hasUserKeyShape(positive)).toBe(true);
      expect(hasUserKeyShape(boundary)).toBe(true);
      expect(hasUserKeyShape(negative)).toBe(false);
      expect(() => admitCloudSubmission({ instruction: positive })).toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
      expect(admitCloudSubmission({ instruction: negative }).instruction).toBe(negative);
    });
  }
  for (const text of ['sk_live_0123456789abcdef', 'ghp_0123456789abcdef', 'AKIA0123456789ABCDEF', 'xoxb-0123456789abcdef']) {
    it('keeps an unsupported format outside the best-effort detector', () => {
      expect(hasUserKeyShape(text)).toBe(false);
      expect(admitCloudSubmission({ instruction: text }).instruction).toBe(text);
    });
  }
  it('requires exactly 32 lower-case hex digits for the dot format', () => {
    expect(hasUserKeyShape(`${'a'.repeat(31)}.${'x'.repeat(16)}`)).toBe(false);
    expect(hasUserKeyShape(`${'G'.repeat(32)}.${'x'.repeat(16)}`)).toBe(false);
  });
  it('admits ordinary prose while preserving the documented best-effort limitation', () => {
    expect(hasUserKeyShape('Explain API keys without sharing one.')).toBe(false);
    expect(admitCloudSubmission({ instruction: 'Explain API keys without sharing one.' }).instruction).toBe('Explain API keys without sharing one.');
  });
});
