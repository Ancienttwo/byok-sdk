import { describe, expect, it } from 'vitest';
import { admitCloudPayload, admitCloudText } from '../src/input-guard';

// Keep fixture keys local to the test. Failure output asserts only fixed codes.
const primary = 'zai-PlatformSecret0123456789Aa';
const unused = 'UnusedProviderSecret0123456789Aa';
const env = { AIPHABEE_ZAI_API_KEY: primary, AIPHABEE_DEEPSEEK_API_KEY: unused };
const user = 'sk-proj-UserSecret0123456789Aa';

describe('shared cloud input guard', () => {
  it('admits ordinary decoded JSON including repeated acyclic data and null-prototype objects', async () => {
    const reused = { message: 'ordinary text' };
    await expect(admitCloudPayload(env, { ok: true, data: [reused, reused, null, 1], usage: { credits: 1 } })).resolves.toBeUndefined();
    const value = Object.create(null) as Record<string, unknown>; value.text = 'ordinary';
    await expect(admitCloudPayload(env, value)).resolves.toBeUndefined();
  });
  it('checks every valid configured key, including an unused provider', async () => {
    await expect(admitCloudText(env, unused, 'zai_openai')).rejects.toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
    await expect(admitCloudText(env, primary, 'deepseek_direct')).rejects.toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
  });
  it('checks exact keys, fragments, percent encoding, and base64 with the existing guard', async () => {
    const forms = [primary, primary.slice(4, 20), Array.from(primary, char => `%${char.charCodeAt(0).toString(16)}`).join(''),
      btoa(primary), btoa(unused).replace(/=+$/, '')];
    for (const form of forms) await expect(admitCloudText(env, `prefix ${form} suffix`)).rejects.toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
  });
  it('checks recognizable user-key shapes without a configured platform key', async () => {
    await expect(admitCloudText({}, user)).rejects.toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
    await expect(admitCloudPayload({}, { [user]: 'ordinary' })).rejects.toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
  });
  it('checks decoded object keys, arrays, envelope metadata and progress', async () => {
    const escape = (key: string) => Array.from(key, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const cases: unknown[] = [
      { [primary]: 'ordinary' }, { data: [unused] }, { ok: true, metadata: { nested: primary }, usage: { credits: 1 } },
      { progress: { message: primary } }, JSON.parse(`{"${escape(primary)}":"ordinary"}`),
      JSON.parse(`{"text":"${escape(unused)}"}`),
    ];
    for (const value of cases) await expect(admitCloudPayload(env, value)).rejects.toThrow('CLOUD_USER_CREDENTIAL_REJECTED');
  });
  it('does not include a rejected key or upstream cause in errors', async () => {
    for (const value of [{ metadata: primary }, { [primary]: 'ordinary' }]) {
      try { await admitCloudPayload(env, value); throw new Error('Guard did not reject'); }
      catch (error) {
        expect(error).toMatchObject({ message: 'CLOUD_USER_CREDENTIAL_REJECTED', code: 'CLOUD_USER_CREDENTIAL_REJECTED', retryable: false });
        expect(String(error)).not.toContain(primary); expect((error as Error).stack).not.toContain(primary);
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });
  it('ignores a malformed unused profile only when a provider was selected', async () => {
    const broken = { AIPHABEE_ZAI_API_KEY: primary, AIPHABEE_DEEPSEEK_API_KEY: 'malformed' };
    await expect(admitCloudText(broken, 'safe', 'zai_openai')).resolves.toBeUndefined();
    await expect(admitCloudPayload(broken, { text: 'safe' }, 'zai_openai')).resolves.toBeUndefined();
    await expect(admitCloudText(broken, 'safe')).rejects.toThrow('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
    await expect(admitCloudText(broken, 'safe', 'deepseek_direct')).rejects.toThrow('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
  });
  it('keeps binding failures fixed and does not coerce credential objects', async () => {
    let reads = 0;
    const broken = { AIPHABEE_ZAI_API_KEY: { toString() { reads++; throw new Error(primary); } } };
    await expect(admitCloudText(broken, 'safe', 'zai_openai')).rejects.toThrow('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
    expect(reads).toBe(0);
    const thrown = Object.defineProperty({}, 'AIPHABEE_ZAI_API_KEY', { get() { throw new Error(primary); } });
    await expect(admitCloudText(thrown, 'safe')).rejects.toThrow('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
  });
  it('preserves missing-binding behavior; credential preflight belongs to the host', async () => {
    await expect(admitCloudText({}, 'safe', 'zai_openai')).resolves.toBeUndefined();
  });
  it('rejects non-JSON data without invoking accessors or toJSON', async () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return primary; } });
    const hidden = Object.defineProperty({}, 'hidden', { value: 'safe' });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const cases: unknown[] = [undefined, NaN, Infinity, 1n, () => {}, new Date(), accessor, hidden, cyclic,
      { value: undefined }, { toJSON() { calls++; return primary; } }, { [Symbol('field')]: 'safe' }, new Array(1)];
    for (const value of cases) await expect(admitCloudPayload(env, value)).rejects.toThrow('CLOUD_REQUEST_INVALID');
    expect(calls).toBe(0);
  });
  it('enforces depth and node limits', async () => {
    let nested: unknown = 'safe';
    for (let i = 0; i < 33; i++) nested = [nested];
    await expect(admitCloudPayload({}, nested)).rejects.toThrow('CLOUD_REQUEST_INVALID');
    await expect(admitCloudPayload({}, Array.from({ length: 10_000 }, () => null))).rejects.toThrow('CLOUD_REQUEST_INVALID');
    await expect(admitCloudPayload({}, Array.from({ length: 9_999 }, () => null))).resolves.toBeUndefined();
  });
});
