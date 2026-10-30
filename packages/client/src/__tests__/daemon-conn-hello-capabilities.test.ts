import { testRuntimeEnv } from './fixtures/runtime-env';
import { testAgentHomeConfig } from './fixtures/test-agent';
import { builtAgentMemoryFilesystemHelperBin } from './fixtures/agent-memory-helper-build';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapter } from '../types';
import { TestServer } from './fixtures/test-server';
import { fakeHermesCommand } from './fixtures/fake-hermes-command';
import { AGENT_MEMORY_INTENT_CAPABILITY, createEnvelope } from '@byok-sdk/protocol';
import { isAgentMemorySecureFilesystemAvailable } from '../daemon/agent-memory';
import * as memoryRuntime from '../daemon/agent-memory';
import { CursorStore } from '../daemon/cursor-store';
import * as helperClient from '../daemon/agent-memory-fs-helper';
import type { AgentMemoryIntentTransport } from '@byok-sdk/protocol/agent-memory';

const helperBuilt = builtAgentMemoryFilesystemHelperBin() !== undefined;
const itProvenBackend = process.platform === 'darwin' && !helperBuilt ? it.skip : it;
const itMacHelper = process.platform === 'darwin' && helperBuilt ? it : it.skip;
const itWindowsHelper = process.platform === 'win32' && helperBuilt ? it : it.skip;

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
  // Windows spawns no script without a shell: each fixture runs behind a
  // compiled launcher there (the Hermes fixture launcher; POSIX keeps the script).
  let piCommand: string;
  let claudeCommand: string;
  let codexCommand: string;

  beforeAll(async () => {
    const launchers = await tmpDir('byok-conn-hello-launchers-');
    const launcher = async (script: string, name: string) => {
      const directory = path.join(launchers, name);
      await fs.mkdir(directory);
      return fakeHermesCommand(script, directory);
    };
    piCommand = await launcher(PI_FIXTURE, 'pi');
    claudeCommand = await launcher(CLAUDE_FIXTURE, 'claude');
    codexCommand = await launcher(CODEX_FIXTURE, 'codex');
  }, 60_000);

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('advertises truthful, per-runtime capabilities for all three bundled runtimes', async () => {
    const pi = new PiAdapter({ resolveBin: () => ({ command: piCommand, source: 'env' }) });
    const claude = new ClaudeAdapter({ resolveBin: () => ({ command: claudeCommand, source: 'path' }) });
    const codex = new CodexAdapter({ resolveBin: () => ({ command: codexCommand, source: 'path' }) });

    const storeDir = await tmpDir('byok-conn-hello-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        agentHome: testAgentHomeConfig(),
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
      // The capability matrix (#1103) rides on the same object.
      toolAuthorizationAuto: true,
      preparedLane: true,
      isolation: { userContext: true, userMcpServers: false, sessionPersistence: false },
    });

    // Claude still supports plan; its private confirm/approval MCP path has been removed.
    expect(byId.get('claude')).toEqual({
      steer: false,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
      messageDraft: true,
      toolAuthorizationAuto: true,
      preparedLane: false,
      isolation: { userContext: true, userMcpServers: true, sessionPersistence: true },
    });

    // codex: persistent app-server steering with YOLO-only auto permission mode.
    expect(byId.get('codex')).toEqual({
      steer: true,
      resume: true,
      approvalInteractive: false,
      mcpToolsets: true,
      messageDraft: true,
      preparedLane: false,
      isolation: { userContext: false, userMcpServers: true, sessionPersistence: false },
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
 * `conn.hello.capabilities` carries the CONNECTION-level flags, distinct from
 * the per-runtime `conn.hello.runtimes[].capabilities` matrix the describe
 * block above covers. Wire v4 has no approval flag: every approval request
 * and decision names its approval.
 */
describe('conn.hello.capabilities', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('advertises exactly the connection flags, with no approval flag', async () => {
    const pi = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }) });

    const storeDir = await tmpDir('byok-conn-hello-capflags-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, storeDir },
      [pi],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((e) => e.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');

    // `blob-upload` is unconditional, not gated on any adapter's own
    // `capabilities()` the way `steer` is.
    expect(hello.payload.capabilities).toEqual(['steer', 'blob-upload', 'terminal-projection-selection', 'dispatch-selection', 'toolset-selection', 'custom-harness']);
  });

  it('withholds dispatch-selection when a custom built-in-id adapter has not opted into exact target semantics', async () => {
    const opaquePi: RuntimeAdapter = {
      runtimeEnvironment: async () => testRuntimeEnv(),
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
    const storeDir = await tmpDir('byok-conn-hello-capflags-custom-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, storeDir },
      [opaquePi],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).not.toContain('dispatch-selection');
  });

  it('withholds dispatch-selection when no selectable runtime adapter is configured', async () => {
    const storeDir = await tmpDir('byok-conn-hello-capflags-empty-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'test-product', serverUrl: server.url, storeDir },
      [],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).not.toContain('dispatch-selection');
  });

  it('advertises agent-home-contract only when an absolute hostStorageRoot is configured', async () => {
    const storeDir = await tmpDir('byok-conn-hello-agent-store-');
    const hostStorageRoot = await tmpDir('byok-conn-hello-agent-root-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
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

  // #614: `none` runs on every Agent-home daemon, so the flag does not follow memory admission.
  it('advertises agent-memory-selection with the Agent home, also when agentMemoryMcp is off', async () => {
    const storeDir = await tmpDir('byok-conn-hello-memory-store-');
    const hostStorageRoot = await tmpDir('byok-conn-hello-memory-root-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        storeDir,
        agentHome: { hostStorageRoot },
        agentMemoryMcp: 'off',
      },
      [],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).toContain('agent-memory-selection');
  });

  // #815: `read-if-admitted` runs as `none` without admission, so its flag does not follow admission either.
  it('advertises agent-memory-read-if-admitted with the Agent home, also when agentMemoryMcp is off', async () => {
    const storeDir = await tmpDir('byok-conn-hello-memory-if-store-');
    const hostStorageRoot = await tmpDir('byok-conn-hello-memory-if-root-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        storeDir,
        agentHome: { hostStorageRoot },
        agentMemoryMcp: 'off',
      },
      [],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).toContain('agent-memory-read-if-admitted');
  });

  // #833: `read-write-if-admitted` runs as `none` without admission, so its flag does not follow admission either.
  it('advertises agent-memory-read-write-if-admitted with the Agent home, also when agentMemoryMcp is off', async () => {
    const storeDir = await tmpDir('byok-conn-hello-memory-rw-if-store-');
    const hostStorageRoot = await tmpDir('byok-conn-hello-memory-rw-if-root-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        storeDir,
        agentHome: { hostStorageRoot },
        agentMemoryMcp: 'off',
      },
      [],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((event) => event.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).toContain('agent-memory-read-write-if-admitted');
  });

  it('fails start before advertising Agent capability when hostStorageRoot is not a directory', async () => {
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
        storeDir,
        agentHome: { hostStorageRoot },
      },
      [],
    );
    await daemon.pair('pairing-code');

    await expect(daemon.start()).rejects.toThrow(/hostStorageRoot/);
    expect(server.received.some((event) => event.type === 'conn.hello')).toBe(false);
  });
});

/**
 * WP2I-S2: `agent-memory-intent.v1` is advertised only when a Host transport,
 * an Agent home, the secure memory filesystem and a backend whose ledger write
 * is a proven durable barrier are ALL present. Today that is the native Linux
 * descriptor backend or the SDK macOS helper after a real volume probe.
 * Windows never advertises: its helper admits recall and save without B.
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
    const storeDir = await tmpDir('byok-conn-hello-intent-store-');
    lastStoreDir = storeDir;
    const hostStorageRoot = await tmpDir('byok-conn-hello-intent-root-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
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

  itProvenBackend('advertises with a transport and an Agent home with a proven Linux or SDK macOS backend', async () => {
    const capabilities = await helloCapabilities({ transport });
    if (isAgentMemorySecureFilesystemAvailable(false) || process.platform === 'darwin') {
      expect(capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    } else {
      // The Windows helper backend has no strict ledger barrier.
      expect(capabilities).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
    }
  });

  it('does not advertise without a Host transport', async () => {
    expect(await helloCapabilities({})).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
  });

  it('does not advertise without an Agent home', async () => {
    expect(await helloCapabilities({ transport, agentHome: false })).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
  });

  itMacHelper('advertises on macOS only after the SDK helper passes the real volume probe', async () => {
    const capabilities = await helloCapabilities({ transport });
    expect(capabilities).toContain(AGENT_MEMORY_INTENT_CAPABILITY);
  });

  itWindowsHelper('withholds Windows intents with the SDK helper, before any volume probe', async () => {
    const probe = vi.spyOn(helperClient, 'openAgentMemoryFilesystemHelper');
    try {
      expect(await helloCapabilities({ transport })).not.toContain(AGENT_MEMORY_INTENT_CAPABILITY);
      expect(probe).not.toHaveBeenCalled();
    } finally { probe.mockRestore(); }
  });

  itMacHelper.each(['ENOTSUP', 'EINVAL', 'EPERM', 'EIO'])('withholds macOS intents when the real-volume helper probe refuses %s', async code => {
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

  it.each([['x64', true], ['arm64', false]] as const)('Windows %s has a secure memory backend only with a helper: %s', (arch, withHelper) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const actualArch = Object.getOwnPropertyDescriptor(process, 'arch');
    if (platform === undefined || actualArch === undefined) throw new Error('process descriptors are unavailable');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    Object.defineProperty(process, 'arch', { ...actualArch, value: arch });
    try {
      expect(isAgentMemorySecureFilesystemAvailable(false)).toBe(false);
      expect(isAgentMemorySecureFilesystemAvailable(true)).toBe(withHelper);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      Object.defineProperty(process, 'arch', actualArch);
    }
  });

  it('rejects a malformed transport at construction', async () => {
    const storeDir = await tmpDir('byok-conn-hello-intent-bad-store-');
    expect(() => createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' },
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        agentHome: testAgentHomeConfig(),
        storeDir,
        agentMemoryIntents: { fetch: async () => undefined } as unknown as AgentMemoryIntentTransport,
      },
      [],
    )).toThrow(/agentMemoryIntents must be a transport/u);
  });
});
