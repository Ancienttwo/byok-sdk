import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapter } from '../types';
import { TestServer } from './fixtures/test-server';

const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Pre-freeze protocol addition (`RuntimeInfo.capabilities`, `messages.ts`):
 * `conn.hello.runtimes[]` now carries each detected runtime's own
 * steer/resume/approvalInteractive/permissionModes, surfaced by
 * `create-daemon.ts`'s `detectRuntimes`/`toRuntimeInfoCapabilities`. This
 * exercises the FULL real path (all three bundled adapters, driven through
 * their real fixture binaries — the same fixtures each adapter's own test
 * file uses — talking to a real in-process WS server) rather than a stub,
 * so the truthful per-runtime matrix asserted below is exactly what a real
 * `conn.hello` on the wire would contain: each adapter's own already-tested
 * `capabilities()` (see `pi-adapter.test.ts`/`claude-adapter.test.ts`/
 * `codex-adapter.test.ts`) — including `approvalInteractive`, which S0
 * (H-002/H-003) turned into a pure passthrough of adapter truth instead of
 * the hardcoded `false` `toRuntimeInfoCapabilities` used to layer on.
 */
describe('conn.hello runtimes[].capabilities (pre-freeze RuntimeInfo.capabilities addition)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('advertises truthful, per-runtime capabilities for all three bundled runtimes', async () => {
    const pi = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }) });
    const claude = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
    const codex = new CodexAdapter({ resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }) });

    const workspaceRoot = await tmpDir('byok-conn-hello-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-store-');
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        mcpToolsets: {
          'salesko.connectors': {
            mcpServers: {
              salesko: { command: '/private/device/salesko-connector', args: ['--stdio'] },
            },
          },
          'crm.readonly': {
            mcpServers: {
              crm: { command: '/private/device/crm-connector' },
            },
          },
        },
      },
      [pi, claude, codex],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((e) => e.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');

    expect(hello.payload.clientVersion).toBe('0.0.0-test');
    const runtimes = hello.payload.runtimes ?? [];
    expect(hello.payload.capabilities).toContain('toolset-selection');
    expect(hello.payload.configuredToolsets).toEqual(['crm.readonly', 'salesko.connectors']);
    expect(JSON.stringify(hello.payload)).not.toContain('/private/device/salesko-connector');
    expect(JSON.stringify(hello.payload)).not.toContain('/private/device/crm-connector');
    expect(JSON.stringify(hello.payload)).not.toContain('--stdio');
    expect(runtimes).toHaveLength(3);
    const byId = new Map(runtimes.map((r) => [r.id, r.capabilities]));

    // pi: the only bundled runtime that can express mid-turn steering; its
    // task-scoped pi-mcp-adapter bridge also consumes selected MCP toolsets.
    expect(byId.get('pi')).toEqual({
      steer: true,
      resume: true,
      mcpToolsets: true,
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly'],
    });

    // claude: no mid-turn steer (writes queue as a follow-up turn instead —
    // see claude-adapter.ts), but does support the extra `plan` permission
    // mode, and (M4 Phase 3) `confirm` via --permission-prompt-tool.
    // GAP-001/H-003: `approvalInteractive` is now `true` here — it comes
    // straight from `ClaudeAdapter.capabilities()`, whose confirm path is
    // genuinely wired (permission-prompt-tool → approval MCP → control
    // socket), rather than the hardcoded `false` the daemon used to stamp
    // on every runtime.
    expect(byId.get('claude')).toEqual({
      steer: false,
      resume: true,
      approvalInteractive: true,
      mcpToolsets: true,
      permissionModes: ['auto', 'readonly', 'plan', 'confirm'],
    });

    // codex: no mid-turn steer (codex exec has no in-band channel — see
    // codex-adapter.ts), and only auto/readonly permission modes.
    expect(byId.get('codex')).toEqual({
      steer: false,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
      permissionModes: ['auto', 'readonly'],
    });

    // The wire value is adapter-generated, never a constant: the three
    // bundled runtimes must NOT all report the same thing. pi and codex have
    // no `needs_approval` notion at all (`resolveApproval()` throws), claude
    // does.
    expect(byId.get('pi')?.approvalInteractive).toBe(false);
    expect(byId.get('claude')?.approvalInteractive).toBe(true);
    expect(byId.get('codex')?.approvalInteractive).toBe(false);

    daemon.reloadMcpToolsets(
      { mail: { mcpServers: { gmail: { command: '/private/device/gmail-connector' } } } },
      daemon.status().toolsets.revision,
    );
    server.dropConnection();
    await vi.waitFor(
      () => expect(server.received.filter((envelope) => envelope.type === 'conn.hello')).toHaveLength(2),
      { timeout: 5_000 },
    );
    const reconnectedHello = server.received.filter((envelope) => envelope.type === 'conn.hello').at(-1);
    if (reconnectedHello?.type !== 'conn.hello') throw new Error('unreachable');
    expect(reconnectedHello.payload.configuredToolsets).toEqual(['mail']);
    expect(JSON.stringify(reconnectedHello.payload)).not.toContain('/private/device/gmail-connector');
  });
});

/**
 * C2 (cross-model review, P2): `computeCapabilities` (`create-daemon.ts`)
 * used to emit only `steer`/`blob-upload` on `conn.hello.capabilities` — the
 * CONNECTION-level flags, distinct from the per-runtime
 * `conn.hello.runtimes[].capabilities` matrix the describe block above
 * covers. This daemon has unconditionally included `approvalId` on
 * `task.await_approval`/`task.approve`/`task.reject` since M5, but never
 * advertised the `approval-targeting` flag saying so, so the server's own
 * `targeted` marking (`ConnectionHub.approveTask`/`rejectTask`,
 * `packages/server/src/hub.ts`) always treated every daemon as legacy.
 */
describe('conn.hello.capabilities (C2: approval-targeting)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('advertises approval-targeting unconditionally, alongside the pre-existing steer/blob-upload flags', async () => {
    const pi = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }) });

    const workspaceRoot = await tmpDir('byok-conn-hello-capflags-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-capflags-store-');
    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [pi],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((e) => e.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');

    expect(hello.payload.capabilities).toContain('approval-targeting');
    expect(hello.payload.capabilities).toContain('dispatch-selection');
    // Unconditional, exactly like `blob-upload` — not gated on any
    // adapter's own `capabilities()` the way `steer` is.
    expect(hello.payload.capabilities).toContain('blob-upload');
  });

  it('withholds dispatch-selection when a custom built-in-id adapter has not opted into exact target semantics', async () => {
    const opaquePi: RuntimeAdapter = {
      descriptor: freezeRuntimeAdapterDescriptor({
        id: 'pi',
        supportsDispatchSelection: false,
        capabilities: {
          steer: false,
          resume: false,
          approvalInteractive: false,
          permissionModes: ['auto'],
        },
        environmentRequirements: { credentialNames: [] },
      }),
      async detect() {
        return { present: true };
      },
      async prepare() {
        return { kind: 'reject', reason: 'not used by capability handshake test', retryable: false };
      },
    };
    const workspaceRoot = await tmpDir('byok-conn-hello-capflags-custom-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-capflags-custom-store-');
    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [opaquePi],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).not.toContain('dispatch-selection');
  });

  it('withholds dispatch-selection when no selectable runtime adapter is configured', async () => {
    const workspaceRoot = await tmpDir('byok-conn-hello-capflags-empty-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-capflags-empty-store-');
    daemon = createDaemonWithAdapters(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).not.toContain('dispatch-selection');
  });

  it('advertises agent-home-contract only when an absolute hostStorageRoot is configured', async () => {
    const workspaceRoot = await tmpDir('byok-conn-hello-agent-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-agent-store-');
    const hostStorageRoot = await tmpDir('byok-conn-hello-agent-root-');
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
      },
      [],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).toContain('agent-home-contract');
  });

  it('fails start before advertising Agent capability when hostStorageRoot is not a directory', async () => {
    const workspaceRoot = await tmpDir('byok-conn-hello-agent-invalid-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-agent-invalid-store-');
    const parent = await tmpDir('byok-conn-hello-agent-invalid-root-');
    const hostStorageRoot = path.join(parent, 'not-a-directory');
    await fs.writeFile(hostStorageRoot, 'not a directory');
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
      },
      [],
    );
    await daemon.pair('pairing-code');

    await expect(daemon.start()).rejects.toThrow(/hostStorageRoot/);
    expect(server.received.some((event) => event.type === 'conn.hello')).toBe(false);
  });

  it('rejects simultaneous Agent-home and Git workspace authorities', async () => {
    const workspaceRoot = await tmpDir('byok-conn-hello-agent-git-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-agent-git-store-');
    const hostStorageRoot = await tmpDir('byok-conn-hello-agent-git-root-');

    expect(() => createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentHome: { hostStorageRoot },
        gitWorkspace: { mode: 'local-checkpoints' },
      },
      [],
    )).toThrow(/mutually exclusive/);
  });
});
