import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  TASK_FAIL_REASON_MAX_BYTES,
  boundFailureReason,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
} from '../index';
import { boundFailureReason as constantsEntryBound } from '../constants';

const TASK_ID = '7c5b6b0e-7d0b-4d5f-9b0a-2b9f8b4f0c11';
const bytes = (text: string) => new TextEncoder().encode(text).length;

// Fake credentials, assembled so no literal key shape sits in the source.
const FAKE = {
  anthropic: ['sk', 'ant', 'api03', 'Zx9qW3eR5tY7uI1oP2aS4dF6gH8jK0lM'].join('-'),
  openai: ['sk', 'proj', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6'].join('-'),
  xai: ['xai', 'FakeTokenValueForTestingOnlyXyz09'].join('-'),
  google: ['AIza', 'SyD3f4G5h6J7k8L9z0X1c2V3b4N5m6Q7w8E'].join(''),
  github: ['ghp', 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5'].join('_'),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJlLWZha2U'].join('.'),
  bearer: 'opaqueBearerValue0123456789',
  password: 'hunter2-correct-horse',
};

describe('boundFailureReason (#1124)', () => {
  it('is the same function on the schema-free and full protocol entries', () => {
    expect(constantsEntryBound).toBe(boundFailureReason);
    expect(TASK_FAIL_REASON_MAX_BYTES).toBe(2048);
  });

  it.each([
    ['an Authorization header', `request failed: Authorization: Bearer ${FAKE.bearer}`, FAKE.bearer, 'Authorization: [redacted]'],
    ['a JSON authorization field', `{"authorization": "Basic ${FAKE.bearer}"}`, FAKE.bearer, '"authorization": [redacted]'],
    ['a bare Bearer token', `upstream said: bearer ${FAKE.bearer} rejected`, FAKE.bearer, 'bearer [redacted] rejected'],
    ['an Anthropic key', `invalid x-api-key ${FAKE.anthropic}`, FAKE.anthropic, 'invalid x-api-key [redacted]'],
    ['an OpenAI project key', `key ${FAKE.openai} revoked`, FAKE.openai, 'key [redacted] revoked'],
    ['an xAI key', `using ${FAKE.xai}`, FAKE.xai, 'using [redacted]'],
    ['a Google key', `maps request with ${FAKE.google}`, FAKE.google, 'maps request with [redacted]'],
    ['a GitHub token', `clone with ${FAKE.github}`, FAKE.github, 'clone with [redacted]'],
    ['a JWT', `session ${FAKE.jwt} expired`, FAKE.jwt, 'session [redacted] expired'],
    ['a *_KEY assignment', `env ANTHROPIC_API_KEY=plainvalue123 set`, 'plainvalue123', 'ANTHROPIC_API_KEY=[redacted] set'],
    ['a *_TOKEN assignment', `GITHUB_TOKEN="quoted value"`, 'quoted value', 'GITHUB_TOKEN=[redacted]'],
    ['a *_SECRET assignment', `client_secret: s3cr3tv4lue`, 's3cr3tv4lue', 'client_secret: [redacted]'],
    ['a *PASSWORD* assignment', `DB_PASSWORD_FILE=${FAKE.password}`, FAKE.password, 'DB_PASSWORD_FILE=[redacted]'],
    ['URL userinfo', `connect postgres://admin:${FAKE.password}@db.internal:5432/app failed`, FAKE.password, 'postgres://[redacted]@db.internal'],
  ])('redacts %s', (_label, input, secret, expected) => {
    const out = boundFailureReason(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(expected);
  });

  it('leaves ordinary diagnostics and closed codes untouched', () => {
    for (const text of [
      'claude process exited (code=1, signal=null); stderr: error: unknown option --frobnicate',
      'task-runner failed; max_tokens: 4096 exceeded',
      'terminal_result_too_large',
      'daemon_interrupted',
      'runtime adapter contract violation during start',
      'https://api.example.com/v1/messages returned 503',
    ]) expect(boundFailureReason(text)).toBe(text);
  });

  it.each([
    [JSON.stringify({ DB_PASSWORD: 'before"sensitive-after', status: 'failed' }), '{"DB_PASSWORD":[redacted],"status":"failed"}'],
    [JSON.stringify({ authorization: 'before\\"sensitive-after', status: 'failed' }), '{"authorization":[redacted],"status":"failed"}'],
    [String.raw`DB_PASSWORD='before\'sensitive-after' status=failed`, 'DB_PASSWORD=[redacted] status=failed'],
    [String.raw`DB_PASSWORD="before\"sensitive-after`, 'DB_PASSWORD=[redacted]'],
    ['DB_PASSWORD="before\\', 'DB_PASSWORD=[redacted]'],
  ])('redacts the entire escaped quoted value on the wire: %s', (input, expected) => {
    const env = createEnvelope('task.fail', { reason: input, retryable: false }, { taskId: TASK_ID });
    expect(env.payload).toMatchObject({ reason: expected });
    expect(decodeEnvelope(encodeEnvelope(env)).payload).toMatchObject({ reason: expected });
    expect(boundFailureReason(expected)).toBe(expected);
  });

  it('caps the UTF-8 byte length on a code-point boundary with a truncation marker', () => {
    const input = `${'x'.repeat(TASK_FAIL_REASON_MAX_BYTES - 3)}${'🚀'.repeat(1000)}`;
    const out = boundFailureReason(input);
    expect(bytes(out)).toBeLessThanOrEqual(TASK_FAIL_REASON_MAX_BYTES);
    expect(out).not.toContain('\uFFFD');
    const marker = /\u2026\[truncated (\d+) bytes\]$/u.exec(out);
    expect(marker).not.toBeNull();
    expect(bytes(out.slice(0, marker!.index)) + Number(marker![1])).toBe(bytes(input));
  });

  it('redacts before it truncates, so a credential that straddles the cap does not leak a prefix', () => {
    const input = `${'x'.repeat(TASK_FAIL_REASON_MAX_BYTES - 40)} ${FAKE.anthropic} ${'y'.repeat(4096)}`;
    const out = boundFailureReason(input);
    expect(out).not.toContain(FAKE.anthropic.slice(0, 12));
    expect(bytes(out)).toBeLessThanOrEqual(TASK_FAIL_REASON_MAX_BYTES);
  });

  it('is a fixed point, including at every cut through a redaction or truncation marker', () => {
    const seed = `Authorization: Bearer ${FAKE.bearer} | API_KEY=${FAKE.anthropic} | https://u:p@h | GITHUB_TOKEN="${FAKE.github}" | ${FAKE.jwt} | `;
    for (let pad = 0; pad < 160; pad += 1) {
      const once = boundFailureReason(`${'z'.repeat(TASK_FAIL_REASON_MAX_BYTES - 120 + pad)}${seed.repeat(4)}`);
      expect(boundFailureReason(once)).toBe(once);
    }
    const short = boundFailureReason(seed);
    expect(boundFailureReason(short)).toBe(short);
  });

  it('stays linear on adversarial input far beyond the cap', () => {
    const hostile = [
      'key="'.repeat(200_000), 'a.'.repeat(200_000), '://'.repeat(100_000), 'password'.repeat(50_000),
      'authorization: '.repeat(50_000), `token=${' '.repeat(100_000)}[`, 'bearer '.repeat(100_000), 'sk-'.repeat(100_000), 'eyJ.'.repeat(100_000),
    ].join('');
    const started = performance.now();
    const out = boundFailureReason(hostile);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(bytes(out)).toBeLessThanOrEqual(TASK_FAIL_REASON_MAX_BYTES);
  });
});

describe('task.fail reason on the wire (#1124)', () => {
  it('bounds a reason built with createEnvelope', () => {
    const env = createEnvelope('task.fail', { reason: `boom: Authorization: Bearer ${FAKE.bearer}`, retryable: true }, { taskId: TASK_ID });
    expect(env.payload).toMatchObject({ reason: 'boom: Authorization: [redacted]' });
  });

  it('accepts an unbounded, credential-bearing reason on decode and bounds it instead of refusing it', () => {
    const unbounded = encodeEnvelope({ v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: new Date().toISOString(), type: 'task.fail', task_id: TASK_ID,
      payload: { reason: `exit 1; stderr: OPENAI_API_KEY=${FAKE.openai} ${'e'.repeat(64 * 1024)}`, retryable: false } } as never);
    const reason = (decodeEnvelope(unbounded).payload as { reason: string }).reason;
    expect(reason).not.toContain(FAKE.openai);
    expect(reason).toMatch(/^exit 1; stderr: OPENAI_API_KEY=\[redacted\] e+\u2026\[truncated \d+ bytes\]$/u);
    expect(bytes(reason)).toBeLessThanOrEqual(TASK_FAIL_REASON_MAX_BYTES);
  });

  it('round-trips a bounded envelope byte-for-byte', () => {
    const env = createEnvelope('task.fail', { reason: `x=1 ${'x'.repeat(10_000)}`, retryable: false }, { taskId: TASK_ID });
    const wire = encodeEnvelope(env);
    expect(encodeEnvelope(decodeEnvelope(wire))).toBe(wire);
  });
});
