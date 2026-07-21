import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemon, createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * M3-1 white-label config coverage:
 *  - `DaemonConfig.branding` is carried through to `status().branding` verbatim.
 *  - `createDaemon` builds its bundled adapter set FROM `runtimeAllowlist`
 *    (see `create-daemon.ts`'s `buildDefaultAdapters`/`createDaemon` doc
 *    comments for the exact unset-vs-set contract this locks in) instead of
 *    the old hard-wired pi-only default.
 *  - `runtimeAllowlist`'s separate, pre-existing enforcement in
 *    `TaskRunner.pickAdapter` (task-runner.ts, untouched by M3-1) still
 *    fail-closed-declines a disallowed runtime.
 */
describe('DaemonConfig.branding', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  it('is carried through verbatim to status().branding', async () => {
    const workspaceRoot = await tmpDir('byok-branding-workspace-');
    const storeDir = await tmpDir('byok-branding-store-');
    const branding = { displayName: 'Acme Coder', supportUrl: 'https://acme.example/support', accent: '#336699' };

    daemon = createDaemonWithAdapters(
      { productName: 'Acme', productId: 'acme-product', serverUrl: server.url, workspaceRoot, storeDir, branding },
      [new StubRuntimeAdapter('pi')],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    expect(daemon.status().branding).toEqual(branding);
  });

  it('is undefined when the config configures none (no over-eager default)', async () => {
    const workspaceRoot = await tmpDir('byok-branding-workspace-');
    const storeDir = await tmpDir('byok-branding-store-');

    daemon = createDaemonWithAdapters(
      { productName: 'Acme', productId: 'acme-product-nobrand', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter('pi')],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    expect(daemon.status().branding).toBeUndefined();
  });
});

describe('createDaemon — runtimeAllowlist-driven bundled adapter set', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  const ORIGINAL_PI_BIN = process.env.BYOK_PI_BIN;
  const ORIGINAL_CLAUDE_BIN = process.env.BYOK_CLAUDE_BIN;
  const ORIGINAL_CODEX_BIN = process.env.BYOK_CODEX_BIN;

  beforeEach(async () => {
    server = await TestServer.start();
    // createDaemon() constructs `new PiAdapter()`/`new ClaudeAdapter()`/`new
    // CodexAdapter()` with no options, so (unlike createDaemonWithAdapters'
    // own tests elsewhere, which hand-build adapters with an explicit
    // resolveBin override) the fixture binaries can only be substituted
    // out-of-process via these env vars — see each adapter's own
    // resolve-bin.ts doc comment for why this is the only seam available.
    process.env.BYOK_PI_BIN = PI_FIXTURE;
    process.env.BYOK_CLAUDE_BIN = CLAUDE_FIXTURE;
    process.env.BYOK_CODEX_BIN = CODEX_FIXTURE;
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
    if (ORIGINAL_PI_BIN === undefined) delete process.env.BYOK_PI_BIN;
    else process.env.BYOK_PI_BIN = ORIGINAL_PI_BIN;
    if (ORIGINAL_CLAUDE_BIN === undefined) delete process.env.BYOK_CLAUDE_BIN;
    else process.env.BYOK_CLAUDE_BIN = ORIGINAL_CLAUDE_BIN;
    if (ORIGINAL_CODEX_BIN === undefined) delete process.env.BYOK_CODEX_BIN;
    else process.env.BYOK_CODEX_BIN = ORIGINAL_CODEX_BIN;
  });

  it('runtimeAllowlist: ["claude", "codex"] advertises exactly those two runtimes, never pi', async () => {
    const workspaceRoot = await tmpDir('byok-allowlist-workspace-');
    const storeDir = await tmpDir('byok-allowlist-store-');

    daemon = createDaemon({
      productName: 'Test Product',
      productId: 'test-product-claude-codex',
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      runtimeAllowlist: ['claude', 'codex'],
    });
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((e) => e.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    const ids = (hello.payload.runtimes ?? []).map((r) => r.id).sort();
    expect(ids).toEqual(['claude', 'codex']);
  });

  it('no runtimeAllowlist configured defaults to all three bundled runtimes (pi, claude, codex)', async () => {
    const workspaceRoot = await tmpDir('byok-allowlist-workspace-');
    const storeDir = await tmpDir('byok-allowlist-store-');

    daemon = createDaemon({
      productName: 'Test Product',
      productId: 'test-product-default',
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
    });
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((e) => e.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    const ids = (hello.payload.runtimes ?? []).map((r) => r.id).sort();
    expect(ids).toEqual(['claude', 'codex', 'pi']);
  });
});

describe('runtimeAllowlist enforcement regression (TaskRunner.pickAdapter, unchanged by M3-1)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  it('still fail-closed-declines (never claims) a task naming a runtime outside the allowlist', async () => {
    // `runtime` is constrained by the frozen protocol to 'pi'|'claude'|'codex'
    // (RuntimeIdSchema — mirrors daemon-task-loop.test.ts's identical
    // reasoning), so the stubs must claim real runtime ids to exercise a
    // genuine TaskOfferPayload.
    const pi = new StubRuntimeAdapter('pi');
    const claude = new StubRuntimeAdapter('claude');
    const workspaceRoot = await tmpDir('byok-allowlist-enforce-workspace-');
    const storeDir = await tmpDir('byok-allowlist-enforce-store-');

    daemon = createDaemonWithAdapters(
      {
        productName: 'Test Product',
        productId: 'test-product-enforce',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        runtimeAllowlist: ['pi'],
      },
      [pi, claude],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' }, runtime: 'claude' },
        { taskId: 'task-disallowed', seq: server.nextSeq() },
      ),
    );

    const decline = await server.waitFor((e) => e.type === 'task.decline');
    expect(decline.payload).toMatchObject({ retryable: false });
    expect((decline.payload as { reason: string }).reason).toMatch(/allowlist/i);
    expect(server.received.some((e) => e.type === 'task.claim' && e.task_id === 'task-disallowed')).toBe(false);
    expect(claude.startCalls).toHaveLength(0);
  });
});
