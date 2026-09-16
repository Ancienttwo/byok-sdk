import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROLLED_PI_DIRECTORY_ENV_NAMES,
  PROVIDER_CREDENTIAL_ENV_DENY_NAMES,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
} from '@byok-sdk/implementation-identity';
import { parsePiMcpEnvironment, projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import { McpServerPool, parseTaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool';
import { observeMcpServer } from '../mcp/observation';

const fail = (message: string): never => { throw new Error(message); };
const privateNames = [...PROVIDER_CREDENTIAL_ENV_DENY_NAMES, ...CONTROLLED_PI_DIRECTORY_ENV_NAMES, 'BYOK_PI_MCP_CONFIG_PATH'];
const emptyConfig = { mcpServers: {}, observation: {}, permissionMode: 'auto', toolImplementations: {} };
afterEach(() => vi.unstubAllEnvs());

describe('Pi MCP explicit environment boundary', () => {
  it('requires mcpEnv even for an empty task config', () => {
    expect(() => parsePiMcpEnvironment(undefined)).toThrow(/required/u);
    expect(() => parseTaskScopedMcpConfig(emptyConfig, fail)).toThrow(/mcpEnv/u);
    expect(parseTaskScopedMcpConfig({ ...emptyConfig, mcpEnv: {} }, fail).mcpEnv).toEqual({});
  });

  it.each(privateNames)('rejects private name %s instead of silently repairing config', (name) => {
    for (const spelling of [name, name.toLowerCase()]) {
      expect(() => parsePiMcpEnvironment({ [spelling]: 'synthetic' })).toThrow(/private/u);
      expect(() => parseTaskScopedMcpConfig({ ...emptyConfig, mcpEnv: { [spelling]: 'synthetic' } }, fail)).toThrow(/private/u);
    }
  });

  it.each([null, [], { KEY: undefined }, { KEY: 1 }, { '': 'x' }, { 'A=B': 'x' }, { KEY: 'x\0y' }])(
    'rejects malformed explicit environment %#', (value) => {
      expect(() => parsePiMcpEnvironment(value)).toThrow();
    },
  );

  it('projects every shared credential and controlled directory out, preserving unrelated daemon entries', () => {
    const ambient = { PATH: '/fixed/bin', SERVER_TOKEN: 'synthetic-server', OMIT: undefined,
      ...Object.fromEntries(privateNames.flatMap(name => [[name, 'synthetic'], [name.toLowerCase(), 'synthetic']])),
    };
    const projected = projectPiMcpEnvironment(ambient);
    expect(Object.keys(projected).sort()).toEqual(['PATH', 'SERVER_TOKEN']);
    expect(projected.SERVER_TOKEN === ambient.SERVER_TOKEN).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(parsePiMcpEnvironment(projected))).toBe(true);
  });

  it('preserves fixed MCP identity digests when only provider credentials are removed', () => {
    const existing = { HOME: '/fixed/home', PATH: '/fixed/bin', PYTHONPATH: '/fixed/modules',
      ...Object.fromEntries(PROVIDER_CREDENTIAL_ENV_DENY_NAMES.map(name => [name, 'synthetic'])),
    };
    const projected = projectPiMcpEnvironment(existing);
    // Existing MCP vector has no Pi directories; credential projection must not
    // change its already admitted identity. Pin bytes, not just mutual equality.
    for (const env of [existing, projected]) {
      expect(toolImplementationLaunchEnvNamesDigest(env)).toBe('25d519fb877ee70689756a008b3aed9d1221f4ec89bdf103a06cf2f32200743d');
      expect(toolImplementationLoaderEnvValuesDigest(env)).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    }
  });

  it('real MCP child receives only daemon projection plus explicit server env despite polluted Pi ambient', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-env-test-')));
    let pool: McpServerPool | undefined;
    try {
      const marker = path.join(dir, 'names.json');
      const wrapper = path.join(dir, 'server.mjs');
      const fixture = new URL('./fixtures/mcp-fixture-server.mjs', import.meta.url);
      // The recorder emits names and the explicit argument only, never values.
      await fs.writeFile(wrapper, `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},JSON.stringify({names:Object.keys(process.env).sort(),argv:process.argv.slice(2)}));\nawait import(${JSON.stringify(fixture.href)});\n`);
      const daemon = projectPiMcpEnvironment({ PATH: process.env.PATH ?? '', DAEMON_ONLY: 'synthetic',
        // Darwin runtime initializes this variable even for a minimal env.
        ...(process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: process.env.__CF_USER_TEXT_ENCODING ?? '0x0:0:0' } : {}),
        ...Object.fromEntries(privateNames.map(name => [name, 'synthetic'])),
      });
      const server = { command: process.execPath, args: [wrapper, '{}'], env: { SERVER_ONLY: 'synthetic' } };
      const observed = await observeMcpServer('fixture', server, { env: daemon, timeoutMs: 15_000 });
      for (const name of privateNames) vi.stubEnv(name, 'synthetic-parent-only');
      vi.stubEnv('PARENT_ONLY_CANARY', 'synthetic-parent-only');
      await fs.rm(marker);
      pool = new McpServerPool(parseTaskScopedMcpConfig({ ...emptyConfig, mcpEnv: daemon,
        mcpServers: { fixture: server }, launchCwd: dir,
        observation: { fixture: { ...observed, toolsetId: 'fixture.read.v1' } },
      }, fail), fail);
      expect((await pool.observe('fixture')).map(tool => tool.name)).toContain('echo');
      const recorded = JSON.parse(await fs.readFile(marker, 'utf8')) as { names: string[]; argv: string[] };
      expect(recorded.names).toEqual([...Object.keys(daemon), ...Object.keys(server.env)].sort());
      expect(recorded.argv).toEqual(['{}']);
      expect(recorded.names.filter(name => privateNames.includes(name) || name === 'PARENT_ONLY_CANARY')).toEqual([]);
    } finally {
      await pool?.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
