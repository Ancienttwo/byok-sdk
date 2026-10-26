/**
 * #654 E2d-2: the daemon consumes `e2ee.key_package.available` before the
 * journal, like `provider.provisioning.available`. It keeps the row while
 * the member resumes or a Host read fails, and acknowledges every other end,
 * a final Host answer included.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnvelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { MEMBER_CHAIN_MAX_ENTRIES } from '../daemon/e2ee-member-client';
import { testDeviceMemberCustody } from './fixtures/credential-backend';
import { E2eeWebClient } from './fixtures/e2ee-web-client';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const dirs: string[] = [];
const daemons: Daemon[] = [];
let server: TestServer | undefined;

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-key-notice-'));
  dirs.push(root);
  server = await TestServer.start();
  const productId = `key-notice-${randomUUID()}`;
  const storeDir = path.join(root, 'store');
  const daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Key notice test', productId,
    serverUrl: server.url, storeDir,
  }, [new StubRuntimeAdapter('pi')]);
  daemons.push(daemon);
  const web = await E2eeWebClient.create(server.e2ee);
  const custody = testDeviceMemberCustody(productId);
  const cursor = (deviceId: string) => new CursorStore(storeDir).load(server!.url, deviceId);
  return { server, daemon, web, custody, cursor };
}

function notice(server: TestServer, scopeId: string, epoch = 1) {
  return createEnvelope('e2ee.key_package.available', { scopeId, epoch }, { seq: server.nextSeq() });
}

function anchored(custody: { entries: Map<string, string> }): boolean {
  const text = custody.entries.get('member-state');
  return text !== undefined && (JSON.parse(text) as { anchor?: unknown }).anchor !== undefined;
}

function logged(spy: { mock: { calls: unknown[][] } }, text: string): boolean {
  return spy.mock.calls.some((args) => args.map(String).join(' ').includes(text));
}

describe('e2ee.key_package.available (E2d-2)', () => {
  it('fetches and opens the package for a ready member, then acknowledges the notice', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { server, daemon, web, custody, cursor } = await setup();
    const { deviceId } = await daemon.pair('pair-code', { verificationSecret: web.verificationSecret });
    const device = await web.approve(deviceId);
    await daemon.start();
    await vi.waitFor(() => expect(anchored(custody)).toBe(true), { timeout: 5_000 });
    await web.putScope('scope-a', [device]);
    const envelope = notice(server, 'scope-a');
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => expect(await cursor(deviceId)).toBe(envelope.seq), { timeout: 5_000 });
    expect(server.e2ee.packageReads).toBe(1);
    expect(logged(warn, 'was not opened')).toBe(false);
  });

  it('keeps the notice while the member resumes, and acknowledges its redelivery once the member is ready', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, daemon, web, custody, cursor } = await setup();
    const { deviceId } = await daemon.pair('pair-code', { verificationSecret: web.verificationSecret });
    await daemon.start();
    const envelope = notice(server, 'scope-a');
    server.pushLongPollEvent(envelope);
    await vi.waitFor(() => expect(logged(error, `e2ee.key_package.available (seq=${envelope.seq})`)).toBe(true), { timeout: 5_000 });
    expect(logged(error, 'still resuming')).toBe(true);
    expect(await cursor(deviceId)).toBe(0);

    const device = await web.approve(deviceId);
    await web.putScope('scope-a', [device]);
    await vi.waitFor(() => expect(anchored(custody)).toBe(true), { timeout: 10_000 });
    // The mailbox kept the row; TestServer scripts the redelivery.
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => expect(await cursor(deviceId)).toBe(envelope.seq), { timeout: 5_000 });
    expect(server.e2ee.packageReads).toBe(1);
  }, 15_000);

  it('acknowledges a notice on a device that is no member, and reads no package', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { server, daemon, cursor } = await setup();
    const { deviceId } = await daemon.pair('pair-code');
    await daemon.start();
    const envelope = notice(server, 'scope-a');
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => expect(await cursor(deviceId)).toBe(envelope.seq), { timeout: 5_000 });
    expect(logged(warn, 'no E2EE member; ignored')).toBe(true);
    expect(server.e2ee.packageReads).toBe(0);
  });

  it('acknowledges a package that does not open, with a log line', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { server, daemon, web, custody, cursor } = await setup();
    const { deviceId } = await daemon.pair('pair-code', { verificationSecret: web.verificationSecret });
    const device = await web.approve(deviceId);
    await daemon.start();
    await vi.waitFor(() => expect(anchored(custody)).toBe(true), { timeout: 5_000 });
    await web.append('scope-policy', { scopeId: 'scope-a', categories: ['task-input'], members: [web.member.memberId, device.memberId].sort() });
    const pkg = await web.sealPackage('scope-a', device, new Uint8Array(32).fill(5));
    server.e2ee.clientPutPackages({ ...pkg, sig: (await web.sealPackage('scope-a', device, new Uint8Array(32).fill(6))).sig });
    const envelope = notice(server, 'scope-a');
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => expect(await cursor(deviceId)).toBe(envelope.seq), { timeout: 5_000 });
    expect(logged(warn, 'not opened (key_package_signature_invalid)')).toBe(true);
  });

  it('keeps the notice when the Host package read fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, daemon, web, custody, cursor } = await setup();
    const { deviceId } = await daemon.pair('pair-code', { verificationSecret: web.verificationSecret });
    const device = await web.approve(deviceId);
    await daemon.start();
    await vi.waitFor(() => expect(anchored(custody)).toBe(true), { timeout: 5_000 });
    await web.putScope('scope-a', [device]);
    server.e2ee.failPackageReads = 1;
    const envelope = notice(server, 'scope-a');
    server.pushLongPollEvent(envelope);
    await vi.waitFor(() => expect(logged(error, `e2ee.key_package.available (seq=${envelope.seq})`)).toBe(true), { timeout: 5_000 });
    expect(await cursor(deviceId)).toBe(0);
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => expect(await cursor(deviceId)).toBe(envelope.seq), { timeout: 5_000 });
    expect(server.e2ee.packageReads).toBe(1);
  });

  it('acknowledges a notice whose package read the Host refuses for good (#863 M2)', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { server, daemon, web, custody, cursor } = await setup();
    const { deviceId } = await daemon.pair('pair-code', { verificationSecret: web.verificationSecret });
    const device = await web.approve(deviceId);
    await daemon.start();
    await vi.waitFor(() => expect(anchored(custody)).toBe(true), { timeout: 5_000 });
    await web.putScope('scope-a', [device]);
    server.e2ee.rejectPackageReads = 403;
    const envelope = notice(server, 'scope-a');
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => expect(await cursor(deviceId)).toBe(envelope.seq), { timeout: 5_000 });
    expect(logged(warn, "the Host's answer is final (key package read failed with HTTP 403 (forbidden))")).toBe(true);
    const final = warn.mock.calls.map((args) => args.map(String).join(' ')).find((line) => line.includes("the Host's answer is final"));
    expect(final).toBeDefined();
    expect(final).not.toContain('scope-a');
  });

  it('acknowledges a notice whose catch-up meets a chain over the cap (#863 M2)', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { server, daemon, web, custody, cursor } = await setup();
    const { deviceId } = await daemon.pair('pair-code', { verificationSecret: web.verificationSecret });
    const device = await web.approve(deviceId);
    await daemon.start();
    await vi.waitFor(() => expect(anchored(custody)).toBe(true), { timeout: 5_000 });
    await web.putScope('scope-a', [device]);
    server.e2ee.chainResponse = Array.from({ length: 256 }, () => ({}));
    const envelope = notice(server, 'scope-a');
    server.pushLongPollEvent(envelope);
    await vi.waitFor(async () => expect(await cursor(deviceId)).toBe(envelope.seq), { timeout: 5_000 });
    expect(logged(warn, `the member chain is longer than ${MEMBER_CHAIN_MAX_ENTRIES} entries`)).toBe(true);
    expect(server.e2ee.packageReads).toBe(0);
  });
});
