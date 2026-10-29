import { createTestDeviceStore } from './fixtures/device-credentials';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Envelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { ConnectionManager } from '../daemon/connection-manager';
import { CursorStore } from '../daemon/cursor-store';
import type { FleetJitter } from '../daemon/deterministic-jitter';
import { MAX_RETRY_AFTER_MS, parseRetryAfterMs } from '../daemon/long-poll-transport';
import { seedDeviceEnrollment } from './fixtures/device-enrollment';
import { TEST_ACTIVITY_INGRESS } from './fixtures/activity-ingress';

const serverUrl = 'http://backoff.invalid';
const deviceId = 'backoff-device';
const roots: string[] = [];
let connection: ConnectionManager | undefined;

afterEach(async () => {
  await connection?.stop();
  connection = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

type Reply = (route: 'hello' | 'events') => Response | undefined;

/** Only HTTP replies and the delay schedule are fixtures; auth, transport and the reconnect loop are real. */
async function setup(reply: Reply) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-backoff-'));
  roots.push(root);
  const store = createTestDeviceStore(root);
  await seedDeviceEnrollment(store, {
    deviceId, tenantId: 'backoff-tenant', accessToken: 'fixture-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    devicePrivateKeyPem: 'fixture-private-key', devicePublicKey: 'fixture-public-key',
  });
  const auth = new AuthManager({ serverUrl, store });
  await auth.loadExisting();
  const helloAt: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/byok/messages') {
      const { messages } = JSON.parse(String(init?.body)) as { messages: Envelope[] };
      helloAt.push(Date.now());
      return reply('hello') ?? Response.json({
        accepted: messages.length,
        outcomes: messages.map((envelope) => ({ id: envelope.id, outcome: 'accepted' })),
        ingress: TEST_ACTIVITY_INGRESS,
      });
    }
    return reply('events') ?? Response.json({ events: [], cursor: 0, capabilities: [], ingress: TEST_ACTIVITY_INGRESS });
  }));
  const attempts: number[] = [];
  const fleetJitter: FleetJitter = {
    delay: (domain, attempt) => {
      if (domain === 'reconnect') attempts.push(attempt);
      return 1;
    },
  };
  connection = new ConnectionManager({
    serverUrl, deviceId, productId: 'backoff-test', capabilities: [], runtimes: [], auth,
    cursorStore: new CursorStore(root), onEnvelope: () => {}, fleetJitter,
    longPollRetryDelayMs: 1, longPollIdleDelayMs: 1,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { manager: connection, helloAt, attempts };
}

describe('ConnectionManager reconnect backoff (#1118)', () => {
  it('passes a growing attempt to the backoff schedule while the handshake keeps failing', async () => {
    const { manager, attempts } = await setup(route => (route === 'hello' ? new Response('', { status: 503 }) : undefined));
    await manager.start();
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(4));
    expect(attempts.slice(0, 4)).toEqual([0, 1, 2, 3]);
  });

  it('waits at least the Retry-After of a 429 handshake before the next one', async () => {
    let refused = false;
    const { manager, helloAt } = await setup(route => {
      if (route !== 'hello' || refused) return undefined;
      refused = true;
      return new Response('', { status: 429, headers: { 'retry-after': '1' } });
    });
    await manager.start();
    await vi.waitFor(() => expect(manager.isOpen()).toBe(true), { timeout: 3_000 });
    expect(helloAt).toHaveLength(2);
    expect(helloAt[1]! - helloAt[0]!).toBeGreaterThanOrEqual(990);
  });

  it('waits at least the Retry-After of a 429 poll before handshaking again', async () => {
    let polls = 0;
    const { manager, helloAt } = await setup(route => {
      if (route !== 'events') return undefined;
      polls += 1;
      return polls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : undefined;
    });
    await manager.start();
    await vi.waitFor(() => expect(helloAt).toHaveLength(2), { timeout: 3_000 });
    expect(helloAt[1]! - helloAt[0]!).toBeGreaterThanOrEqual(990);
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');

  it('reads delta-seconds and HTTP-dates', () => {
    expect(parseRetryAfterMs('7', now)).toBe(7_000);
    expect(parseRetryAfterMs(' 0 ', now)).toBe(0);
    expect(parseRetryAfterMs('Thu, 29 Oct 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfterMs('Wed, 28 Oct 2026 23:59:00 GMT', now)).toBe(0);
  });

  it('ignores absent or malformed values and bounds long ones', () => {
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs('-5', now)).toBeUndefined();
    expect(parseRetryAfterMs('1.5', now)).toBeUndefined();
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs('999999999', now)).toBe(MAX_RETRY_AFTER_MS);
  });
});
