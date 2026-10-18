import { testScratchRoot } from "./fixtures/execution-scratch";
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
import { AGENT_MEMORY_INTENT_CAPABILITY, createEnvelope } from '@byok-sdk/protocol';
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import * as memoryRuntime from '../daemon/agent-memory';
import { CursorStore } from '../daemon/cursor-store';
import * as helperClient from '../daemon/agent-memory-fs-helper';
import type { AgentMemoryIntentTransport } from '../daemon/agent-memory-intent';

const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Pre-freeze protocol addition (`RuntimeInfo.capabilities`, `messages.ts`):
 * `conn.hello.runtimes[]` now carries each detected runtime's own
 * steer/resume/approvalInteractive, surfaced by
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
      { storage: { scratchRoot: testScratchRoot() },
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
      messageDraft: true,
      approvalInteractive: false,
    });

    // Claude still supports plan; its private confirm/approval MCP path has been removed.
    expect(byId.get('claude')).toEqual({
      steer: false,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
    });

    // codex: persistent app-server steering with YOLO-only auto permission mode.
    expect(byId.get('codex')).toEqual({
      steer: true,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
    });

    // The wire value remains adapter-generated. The shipped adapters all
    // report false after removal of Claude's private interactive approval lane.
    expect(byId.get('pi')?.approvalInteractive).toBe(false);
    expect(byId.get('claude')?.approvalInteractive).toBe(false);
    expect(byId.get('codex')?.approvalInteractive).toBe(false);

    daemon.reloadMcpToolsets(
      { mail: { mcpServers: { gmail: { command: '/private/device/gmail-connector' } } } },
      daemon.status().toolsets.revision,
    );
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
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
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
        },
      }),
      async detect() {
        return { kind: 'available' };
      },
      async prepare() {
        return { kind: 'reject', reason: 'not used by capability handshake test', retryable: false };
      },
    };
    const workspaceRoot = await tmpDir('byok-conn-hello-capflags-custom-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-capflags-custom-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
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
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
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
      { storage: { scratchRoot: testScratchRoot() },
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
      { storage: { scratchRoot: testScratchRoot() },
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
      { storage: { scratchRoot: testScratchRoot() },
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

/**
 * WP2I-S2: `agent-memory-intent.v1` is advertised only when a Host transport,
 * an Agent home, the secure memory filesystem and a backend whose ledger write
 * is a proven durable barrier are ALL present. Today that is the native Linux
 * descriptor backend or the SDK macOS helper after a real volume probe.
 * Windows never advertises.
 */
describe('conn.hello.capabilities (WP2I-S2: agent-memory-intent.v1)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  let lastStoreDir: string;
  const transport: AgentMemoryIntentTransport = {
    fetch: async () => { throw new Error('not reached by a capability test'); },
    complete: async () => { throw new Error('not reached by a capability test'); },
  };

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  async function helloCapabilities(overrides: { transport?: AgentMemoryIntentTransport; agentHome?: boolean; helperBin?: string }): Promise<readonly string[]> {
    const workspaceRoot = await tmpDir('byok-conn-hello-intent-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-intent-store-');
    lastStoreDir = storeDir;
    const hostStorageRoot = await tmpDir('byok-conn-hello-intent-root-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        ...(overrides.agentHome === false ? {} : { agentHome: { hostStorageRoot } }),
        ...(overrides.transport === undefined ? {} : { agentMemoryIntents: overrides.transport }),
        ...(overrides.helperBin === undefined ? {} : { agentMemoryFilesystem: { helperBin: overrides.helperBin } }),
      },
      [],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    return hello.payload.capabilities ?? [];
  }

  it('advertises with a transport and an Agent home with a proven Linux or SDK macOS backend', async () => {
    const capabilities = await helloCapabilities({ transport });
    if (isAgentMemorySecureFilesystemAvailable(process.platform === 'darwin')) {
      expect(capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    } else {
      // Windows has no proven secure backend.
      expect(capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    }
  });

  it('does not advertise without a Host transport', async () => {
    expect(await helloCapabilities({})).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
  });

  it('does not advertise without an Agent home', async () => {
    expect(await helloCapabilities({ transport, agentHome: false })).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
  });

  (process.platform === 'darwin' ? it : it.skip)('advertises on macOS only after the SDK helper passes the real volume probe', async () => {
    const capabilities = await helloCapabilities({ transport });
    expect(capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY);
  });

  (process.platform === 'darwin' ? it : it.skip).each(['ENOTSUP', 'EINVAL', 'EPERM', 'EIO'])('withholds macOS intents when the real-volume helper probe refuses %s', async code => {
    const probe = vi.spyOn(helperClient, 'openAgentMemoryFilesystemHelper').mockRejectedValue(Object.assign(new Error('strict volume barrier failed'), { code }));
    try {
      const capabilities = await helloCapabilities({ transport });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    } finally { probe.mockRestore(); }
  });

  (process.platform === 'linux' ? it : it.skip).each(['EINVAL', 'EPERM', 'EIO'])('withholds Linux intents after a real directory-probe %s and refuses a stale notice before fetch', async code => {
    const originalProbe = memoryRuntime.probeAgentMemoryStrictDirectorySync;
    const originalOpen = fs.open.bind(fs);
    let probing = false;
    let refusals = 0;
    const probe = vi.spyOn(memoryRuntime, 'probeAgentMemoryStrictDirectorySync').mockImplementation(async directory => {
      probing = true;
      try { return await originalProbe(directory); } finally { probing = false; }
    });
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (probing) vi.spyOn(handle, 'sync').mockImplementation(async () => {
        refusals++;
        throw Object.assign(new Error('directory probe refused'), { code });
      });
      return handle;
    });
    const fetch = vi.fn(async () => { throw new Error('must fail before fetch'); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await helloCapabilities({ transport: { fetch, complete: async () => { throw new Error('not reached'); } } })).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
      expect(refusals).toBeGreaterThan(0);
      const notice = createEnvelope('agent.memory.intent.available', { intentId: '00000000-0000-4000-8000-000000000001', agentRef: { agentId: 'one', profileRevision: '1' } }, { seq: server.nextSeq() });
      server.pushLongPollEvent(notice);
      await vi.waitFor(() => expect(errors.mock.calls.some(args => String(args[0]).includes('agent.memory.intent.available') && (args[1] as { reason?: string })?.reason === 'filesystem_unavailable')).toBe(true));
      expect(fetch).not.toHaveBeenCalled();
      const deviceId = daemon?.status().deviceId;
      if (deviceId === undefined) throw new Error('paired device id missing');
      expect(await new CursorStore(lastStoreDir).load(server.url, deviceId)).toBe(0);
    } finally { probe.mockRestore(); open.mockRestore(); errors.mockRestore(); }
  });

  it('Windows has no secure memory backend, with or without a helper', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (descriptor === undefined) throw new Error('process.platform descriptor is unavailable');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    try {
      expect(isAgentMemorySecureFilesystemAvailable(false)).toBe(false);
      expect(isAgentMemorySecureFilesystemAvailable(true)).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('rejects a malformed transport at construction', async () => {
    const workspaceRoot = await tmpDir('byok-conn-hello-intent-bad-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-intent-bad-store-');
    expect(() => createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        agentMemoryIntents: { fetch: async () => undefined } as unknown as AgentMemoryIntentTransport,
      },
      [],
    )).toThrow(/agentMemoryIntents must be a transport/u);
  });
});
