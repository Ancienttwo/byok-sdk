import { describe, expect, it } from 'vitest';
import { CLOUD_ORIGIN, TENANT_A, createHarness } from './support/harness';

const AUTH_JSON_BODY_MAX_BYTES = 16 * 1024;
const MESSAGES_JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function exactJsonBytes(prefix: string, suffix: string, length: number): Uint8Array {
  const paddingLength = length - bytes(prefix + suffix).byteLength;
  if (paddingLength < 0) throw new Error(`Cannot make JSON shorter than ${prefix + suffix}`);
  return bytes(`${prefix}${'x'.repeat(paddingLength)}${suffix}`);
}

function requestWithStream(
  path: string,
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request(`${CLOUD_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  });
}

function cancellableRequest(
  path: string,
  chunk: Uint8Array,
  headers: Record<string, string> = {},
  cancel: () => void = () => {},
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
    },
    cancel,
  });
  return new Request(`${CLOUD_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  });
}

function oversizedJson(limit: number): Uint8Array {
  return bytes(`{"ignored":"${'x'.repeat(limit)}"}`);
}

describe('Cloud JSON request-body limits', () => {
  it.each(['/byok/pair', '/byok/challenge', '/byok/token'])(
    'returns 413 for an over-limit streamed auth body on %s',
    async (path) => {
      const harness = createHarness();
      const encoded = oversizedJson(AUTH_JSON_BODY_MAX_BYTES);
      const request = requestWithStream(path, [encoded.subarray(0, 32), encoded.subarray(32)]);

      expect(request.headers.has('content-length')).toBe(false);
      const response = await harness.cloud.fetch(request);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'request body too large' });
    },
  );

  it('uses streamed bytes as the authority for missing, invalid, and lying-small Content-Length', async () => {
    const harness = createHarness();
    const encoded = new TextEncoder().encode(`{"ignored":"${'x'.repeat(AUTH_JSON_BODY_MAX_BYTES)}"}`);
    const lengths = [undefined, 'invalid', '1'] as const;

    const responses = await Promise.all(lengths.map((contentLength) => {
      const request = requestWithStream(
        '/byok/pair',
        [encoded.subarray(0, 32), encoded.subarray(32)],
        contentLength === undefined ? {} : { 'content-length': contentLength },
      );
      return harness.cloud.fetch(request);
    }));

    expect(responses.map((response) => response.status)).toEqual([413, 413, 413]);
  });

  it('cancels a declared-over-limit request before reading it', async () => {
    const harness = createHarness();
    let cancelled = 0;
    const response = await harness.cloud.fetch(cancellableRequest(
      '/byok/pair',
      bytes('{"ignored":"small"}'),
      { 'content-length': String(AUTH_JSON_BODY_MAX_BYTES + 1) },
      () => { cancelled += 1; },
    ));

    expect(response.status).toBe(413);
    expect(cancelled).toBe(1);
  });

  it('cancels a request after streamed bytes overflow the ceiling', async () => {
    const harness = createHarness();
    let cancelled = 0;
    const response = await harness.cloud.fetch(cancellableRequest(
      '/byok/pair',
      oversizedJson(AUTH_JSON_BODY_MAX_BYTES),
      {},
      () => { cancelled += 1; },
    ));

    expect(response.status).toBe(413);
    expect(cancelled).toBe(1);
  });

  it('returns 413 when cancellation fails after a streamed overflow', async () => {
    const harness = createHarness();
    const response = await harness.cloud.fetch(cancellableRequest(
      '/byok/pair',
      oversizedJson(AUTH_JSON_BODY_MAX_BYTES),
      {},
      () => { throw new Error('test cancellation failure'); },
    ));

    expect(response.status).toBe(413);
  });

  it('accepts an exact auth ceiling and rejects one byte more', async () => {
    const harness = createHarness();
    const prefix = '{"deviceId":"';
    const suffix = '"}';
    const exact = await harness.cloud.fetch(requestWithStream(
      '/byok/challenge',
      [exactJsonBytes(prefix, suffix, AUTH_JSON_BODY_MAX_BYTES)],
    ));
    const plusOne = await harness.cloud.fetch(requestWithStream(
      '/byok/challenge',
      [exactJsonBytes(prefix, suffix, AUTH_JSON_BODY_MAX_BYTES + 1)],
    ));

    expect(exact.status).toBe(401);
    expect(plusOne.status).toBe(413);
  });

  it('keeps malformed under-limit auth JSON at 400 and accepts a normal valid pair body', async () => {
    const harness = createHarness();
    const malformed = await harness.cloud.fetch(requestWithStream('/byok/pair', [bytes('{')]));
    expect(malformed.status).toBe(400);

    const device = await harness.pairDevice(TENANT_A);
    expect(device.accessToken).toBeTypeOf('string');
  });

  it('authenticates messages before applying its body ceiling', async () => {
    const harness = createHarness();
    const response = await harness.cloud.fetch(requestWithStream(
      '/byok/messages',
      [oversizedJson(MESSAGES_JSON_BODY_MAX_BYTES)],
    ));

    expect(response.status).toBe(401);
  });

  it('applies the 2 MiB messages ceiling after authentication and accepts its exact limit', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const headers = device.authorization;
    const prefix = '{"messages":[],"padding":"';
    const suffix = '"}';
    const exact = await harness.cloud.fetch(requestWithStream(
      '/byok/messages',
      [exactJsonBytes(prefix, suffix, MESSAGES_JSON_BODY_MAX_BYTES)],
      headers,
    ));
    const plusOne = await harness.cloud.fetch(requestWithStream(
      '/byok/messages',
      [exactJsonBytes(prefix, suffix, MESSAGES_JSON_BODY_MAX_BYTES + 1)],
      headers,
    ));

    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual({ accepted: 0 });
    expect(plusOne.status).toBe(413);

    const malformed = await harness.cloud.fetch(requestWithStream(
      '/byok/messages',
      [bytes('{')],
      headers,
    ));
    expect(malformed.status).toBe(400);
  });

  it('returns independent 413 responses for concurrent oversized requests', async () => {
    const harness = createHarness();
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      harness.cloud.fetch(requestWithStream('/byok/token', [oversizedJson(AUTH_JSON_BODY_MAX_BYTES)])),
    ));

    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(413));
  });
});
