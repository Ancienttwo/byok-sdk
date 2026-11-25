import { execFile } from 'node:child_process';
import { mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import type * as RootEntry from '../index';
import type * as AdaptersEntry from '../adapters/index';
import type * as TestingEntry from '../testing/index';
import type { RuntimeAdapter } from '../types';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { testScratchRoot } from './fixtures/execution-scratch';
import { FRESH_OFFER } from './fixtures/fresh-offer';
import { testRuntimeEnvironment } from './fixtures/runtime-env';
import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { TestServer } from './fixtures/test-server';

const execFileAsync = promisify(execFile);
const clientRoot = fileURLToPath(new URL('../..', import.meta.url));
const requireFromClient = createRequire(path.join(clientRoot, 'package.json'));
// esbuild is the bundler downstream hosts use; take tsup's copy instead of a new dependency.
const esbuild = createRequire(requireFromClient.resolve('tsup'))('esbuild') as {
  build(options: Record<string, unknown>): Promise<unknown>;
};

/**
 * A consumer that bundles the root entry into one file shares one
 * `import.meta` across every inlined module, so `import.meta.main` is true for
 * all of them. Importing the root entry must still run nothing at load time.
 */
describe('dist/index.js inside a consumer single-file bundle', () => {
  it('loads under node without running any inlined CLI entry', async () => {
    // The scratch dir sits inside the package so externals resolve from its node_modules.
    const scratch = mkdtempSync(path.join(clientRoot, 'node_modules', '.consumer-bundle-'));
    try {
      const entry = path.join(scratch, 'entry.mjs');
      const outfile = path.join(scratch, 'bundle.mjs');
      writeFileSync(entry, `import { BYOK_SDK_HELPER_SUBCOMMAND } from ${JSON.stringify(path.join(clientRoot, 'dist/index.js'))};\nconsole.log('loaded', BYOK_SDK_HELPER_SUBCOMMAND);\n`);
      await esbuild.build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
      });
      const { stdout, stderr } = await execFileAsync(process.execPath, [outfile], { cwd: scratch, timeout: 60_000 });
      expect(stderr).toBe('');
      expect(stdout).toBe('loaded __byok_sdk_helper\n');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * #2505: a Host composes the daemon from the root entry and its adapters from
 * the adapters entry. Both packaged entries must share one runtime-detection
 * state, or the daemon loses the delegated fast admission (#2495) and
 * `prepare()` re-resolves what admission already verified (#2469).
 */
describe.skipIf(process.platform === 'win32')('packaged root and adapters entries (#2505)', () => {
  it('a root-entry daemon keeps an adapters-entry delegation and reuses its verified detection in prepare()', async () => {
    const root = await import(path.join(clientRoot, 'dist/index.js')) as typeof RootEntry;
    const adapters = await import(path.join(clientRoot, 'dist/adapters/index.js')) as typeof AdaptersEntry;
    const testing = await import(path.join(clientRoot, 'dist/testing/index.js')) as typeof TestingEntry;
    const command = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
    const resolveBin = vi.fn(() => ({ command, source: 'env' as const }));
    const claude = new adapters.ClaudeAdapter({ resolveBin });
    const runtimeEnvironment = testRuntimeEnvironment();
    vi.spyOn(claude, 'runtimeEnvironment').mockResolvedValue({ ...runtimeEnvironment, env: { ...runtimeEnvironment.env,
      FAKE_CLAUDE_AUTH_STATUS: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'apiKeyHelper' }) } });
    const detect = vi.fn((signal?: AbortSignal) => claude.detect(signal));
    const decorator = { descriptor: claude.descriptor, detect, prepare: claude.prepare.bind(claude),
      runtimeEnvironment: claude.runtimeEnvironment.bind(claude) } satisfies RuntimeAdapter;
    adapters.delegateAdmissionDetection(decorator, claude);
    const server = await TestServer.start();
    const daemon = root.createDaemonWithAdapters({
      storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' },
      productName: 'Test Product', productId: 'test-product-dist-detection', serverUrl: server.url,
      agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      storeDir: await fs.mkdtemp(path.join(os.tmpdir(), 'byok-dist-detection-')),
    }, [decorator], { deviceCredentials: new testing.InMemoryDeviceCredentialBackend() });
    try {
      await daemon.pair('pairing-code');
      await daemon.start();
      await server.waitFor(envelope => envelope.type === 'conn.hello');
      detect.mockClear();
      resolveBin.mockClear();
      const taskId = 'dist-shared-detection';
      server.send(createEnvelope('task.offer', { target: { lane: 'harness', harnessId: 'claude', selection: { mode: 'subscription', modelId: 'fixture-model' } },
        agentRef: freshTestAgentRef(), instruction: 'x', ...FRESH_OFFER }, { taskId, seq: server.nextSeq() }));
      await server.waitFor(envelope => envelope.type === 'task.decline' && envelope.task_id === taskId);
      // Admission took the delegated fast path, and prepare() launched what it verified.
      expect(detect).not.toHaveBeenCalled();
      expect(resolveBin).toHaveBeenCalledOnce();
    } finally {
      await daemon.stop();
      await server.close();
    }
  }, 60_000);
});
