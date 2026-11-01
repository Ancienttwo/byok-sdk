import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { DshAdapter } from '../adapters/dsh/dsh-adapter';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { HermesAdapter } from '../adapters/hermes/hermes-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { resolveRuntimeCommand, runtimeExecutableFields } from '../adapters/runtime-executable';
import { validateRuntimeDetectResult } from '../runtime-detection';
import type { RuntimeAdapter } from '../types';
import { npmNodeShim } from './fixtures/npm-node-shim';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const windows = process.platform === 'win32';
const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A short real directory: the Hermes fake gateway socket path has a small length limit. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(windows ? os.tmpdir() : '/tmp', prefix));
  dirs.push(dir);
  return fs.realpath(dir);
}

interface Case {
  readonly id: string;
  readonly envName: string;
  readonly fixture: string;
  /** Built without `resolveBin`; the runtime environment searches the live PATH. */
  readonly create: () => Promise<RuntimeAdapter>;
}

const allowlist = { base: 'allowlist' as const };
const CASES: readonly Case[] = [
  { id: 'claude', envName: 'BYOK_CLAUDE_BIN', fixture: fixture('fake-claude.mjs'), create: async () => new ClaudeAdapter({ runtimeEnvironment: allowlist }) },
  { id: 'codex', envName: 'BYOK_CODEX_BIN', fixture: fixture('fake-codex.mjs'), create: async () => new CodexAdapter({ runtimeEnvironment: allowlist }) },
  { id: 'grok', envName: 'BYOK_GROK_BIN', fixture: fixture('fake-acp-agent.mjs'), create: async () => new GrokAdapter({ runtimeEnvironment: allowlist }) },
  {
    id: 'hermes', envName: 'BYOK_HERMES_BIN', fixture: fixture('fake-hermes.mjs'),
    create: async () => new HermesAdapter({ home: await tempDir('bh-'), runtimeEnvironment: { ...allowlist, pass: ['FAKE_HERMES_*'] } }),
  },
  {
    id: 'dsh', envName: 'BYOK_DSH_BIN', fixture: fixture('fake-dsh.mjs'),
    create: async () => new DshAdapter({ home: await tempDir('bd-'), model: { provider: 'deepseek', model: 'deepseek-v4-flash', keyEnv: 'RC_DSH_KEY' }, runtimeEnvironment: allowlist }),
  },
];

/**
 * #1103 O10: detection reports the executable its own resolution chose and
 * ran. A `BYOK_<RUNTIME>_BIN` override names an absolute path; a bare name
 * is found by the OS at spawn, so detection reports only the `path` source
 * and never searches PATH again for a path to show.
 */
describe.skipIf(windows)('runtime detection reports the executable it ran', () => {
  for (const runtime of CASES) {
    it(`${runtime.id}: an env override reports its path and source env`, async () => {
      vi.stubEnv(runtime.envName, runtime.fixture);
      expect(await (await runtime.create()).detect()).toMatchObject({
        kind: 'available', executablePath: runtime.fixture, executableSource: 'env',
      });
    });

    it(`${runtime.id}: a PATH lookup reports source path and no path`, async () => {
      const bin = await tempDir('bp-');
      await fs.symlink(runtime.fixture, path.join(bin, runtime.id));
      vi.stubEnv(runtime.envName, '');
      vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
      const detected = await (await runtime.create()).detect();
      expect(detected).toMatchObject({ kind: 'available', executableSource: 'path' });
      expect(detected).not.toHaveProperty('executablePath');
    });
  }

  it('pi: a Host resolveBin reports source config, because the pi-rpc lane launches that file', async () => {
    const fakePi = fixture('fake-pi.mjs');
    expect(await new PiAdapter({ resolveBin: () => ({ command: fakePi, source: 'env' }) }).detect()).toMatchObject({
      kind: 'available', executablePath: fakePi, executableSource: 'config',
    });
  });

  it('pi: BYOK_PI_BIN alone reports no executable, because every lane then launches an SDK entry', async () => {
    vi.stubEnv('BYOK_PI_BIN', fixture('fake-pi.mjs'));
    const detected = await new PiAdapter().detect();
    expect(detected).toMatchObject({ kind: 'available' });
    expect(detected).not.toHaveProperty('executablePath');
    expect(detected).not.toHaveProperty('executableSource');
  });

  it('claude: the Host resolveBin option reports source config', async () => {
    const fakeClaude = fixture('fake-claude.mjs');
    expect(await new ClaudeAdapter({ resolveBin: () => ({ command: fakeClaude, source: 'path' }) }).detect()).toMatchObject({
      kind: 'available', executablePath: fakeClaude, executableSource: 'config',
    });
  });

  it('an unavailable runtime reports no executable', async () => {
    expect(await new ClaudeAdapter({ resolveBin: () => ({ command: '/nonexistent/claude', source: 'path' }) }).detect())
      .toEqual({ kind: 'not-found' });
  });
});

/**
 * On win32 the adapter's own `resolveRuntimeInvocation` finds Claude and
 * Codex on PATH (PATH order, then PATHEXT), so a bare name reports the file
 * it found: here the npm `.cmd` shim, which the launch runs through node.
 */
describe.runIf(windows)('win32 PATH lookup reports the file the invocation found', () => {
  for (const runtime of CASES.filter((candidate) => candidate.id === 'claude' || candidate.id === 'codex')) {
    it(`${runtime.id}: an npm shim on PATH reports source path and the .cmd path`, async () => {
      const bin = await tempDir('bp-');
      const entry = `${runtime.id}-entry.mjs`;
      await fs.writeFile(path.join(bin, entry), `await import(${JSON.stringify(pathToFileURL(runtime.fixture).href)});\n`);
      await fs.writeFile(path.join(bin, `${runtime.id}.cmd`), npmNodeShim(entry));
      vi.stubEnv(runtime.envName, '');
      vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
      expect(await (await runtime.create()).detect()).toMatchObject({
        kind: 'available', executableSource: 'path', executablePath: path.join(bin, `${runtime.id}.cmd`),
      });
    });
  }
});

describe('runtime executable fields', () => {
  it('names no path for a relative command', () => {
    const relative = resolveRuntimeCommand(undefined, () => ({ command: 'tools/claude', source: 'env' as const }));
    expect(runtimeExecutableFields(relative, relative.bin.command)).toEqual({ executableSource: 'env' });
  });

  it('accepts an absolute path with its source and rejects every other shape', () => {
    const absolute = path.resolve('/opt/claude/bin/claude');
    expect(validateRuntimeDetectResult({ kind: 'available', executablePath: absolute, executableSource: 'env' }))
      .toEqual({ kind: 'available', executablePath: absolute, executableSource: 'env' });
    expect(validateRuntimeDetectResult({ kind: 'available', executableSource: 'path' })).toEqual({ kind: 'available', executableSource: 'path' });
    for (const invalid of [
      { kind: 'available', executablePath: absolute },
      { kind: 'available', executablePath: 'claude', executableSource: 'path' },
      { kind: 'available', executablePath: `${absolute}\n`, executableSource: 'env' },
      { kind: 'available', executablePath: absolute, executableSource: 'package' },
      { kind: 'not-found', executablePath: absolute, executableSource: 'env' },
    ]) {
      expect(() => validateRuntimeDetectResult(invalid), JSON.stringify(invalid)).toThrow(TypeError);
    }
  });
});
