import { describe, expect, it } from 'vitest';
import { admitCloudSubmission, hasUserKeyShape } from '../src/admission';

const KEY = 'sk-proj-User_Aa0123456789SecretKey';
describe('frozen cloud submission admission', () => {
  it('admits only instruction and one frozen profile, defaulting to zai', () => {
    expect(admitCloudSubmission({ instruction: 'Write a paragraph.' })).toEqual({ instruction: 'Write a paragraph.', profile: 'zai_openai' });
    expect(admitCloudSubmission({ instruction: 'Write a paragraph.', profile: 'deepseek_direct' })).toEqual({ instruction: 'Write a paragraph.', profile: 'deepseek_direct' });
  });
  for (const name of ['credential', 'credentials', 'apiKey', 'APIKEY', 'api_key', 'secret', 'authorization', 'Authorization', 'x-api-key', 'headers']) {
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
  it('admits ordinary prose while preserving the documented best-effort limitation', () => {
    expect(hasUserKeyShape('Explain API keys without sharing one.')).toBe(false);
    expect(admitCloudSubmission({ instruction: 'Explain API keys without sharing one.' }).instruction).toBe('Explain API keys without sharing one.');
  });
});
