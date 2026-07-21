import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
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
 * `codex-adapter.test.ts`, all unchanged by this addition) plus
 * `approvalInteractive: false` layered on by `toRuntimeInfoCapabilities`.
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
    const pi = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'path' }) });
    const claude = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
    const codex = new CodexAdapter({ resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }) });

    const workspaceRoot = await tmpDir('byok-conn-hello-workspace-');
    const storeDir = await tmpDir('byok-conn-hello-store-');
    daemon = createDaemonWithAdapters(
      { productName: 'Test Product', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [pi, claude, codex],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const hello = await server.waitFor((e) => e.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');

    const runtimes = hello.payload.runtimes ?? [];
    expect(runtimes).toHaveLength(3);
    const byId = new Map(runtimes.map((r) => [r.id, r.capabilities]));

    // pi: the only bundled runtime that can express mid-turn steering.
    expect(byId.get('pi')).toEqual({
      steer: true,
      resume: true,
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly'],
    });

    // claude: no mid-turn steer (writes queue as a follow-up turn instead —
    // see claude-adapter.ts), but does support the extra `plan` permission
    // mode, and (M4 Phase 3) `confirm` via --permission-prompt-tool.
    // `approvalInteractive` stays `false` regardless — see
    // `toRuntimeInfoCapabilities`'s own doc comment in create-daemon.ts:
    // that flag is hardcoded, not derived from `capabilities().permissionModes`.
    expect(byId.get('claude')).toEqual({
      steer: false,
      resume: true,
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly', 'plan', 'confirm'],
    });

    // codex: no mid-turn steer (codex exec has no in-band channel — see
    // codex-adapter.ts), and only auto/readonly permission modes.
    expect(byId.get('codex')).toEqual({
      steer: false,
      resume: true,
      approvalInteractive: false,
      permissionModes: ['auto', 'readonly'],
    });

    // None of the three bundled runtimes has interactive approval — verified
    // per-adapter (each one's resolveApproval() throws rather than pausing).
    for (const caps of byId.values()) {
      expect(caps?.approvalInteractive).toBe(false);
    }
  });
});
