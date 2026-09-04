/**
 * The `@byok-sdk/client/agent-memory` entry constraint list, made executable.
 *
 * This subpath exists for one reason: an embedded host — a product that runs
 * no daemon and owns no control socket — needs to compose the Agent-memory
 * service itself. Importing any memory symbol from the root entry instead
 * drags the daemon composition and transport layer in with it (the
 * root bundle is ~800 KB; this one is ~38 KB). That difference is not visible
 * in any behavioral test: it shows up as a host bundle that suddenly ships a
 * transport it never calls, or — much worse — as `connectControlClient`
 * becoming reachable and `shutdown`, approval resolution, and the raw task
 * event stream becoming public API in one line.
 *
 * So three properties are pinned here, at the source-module level:
 *
 * 1. The exact module graph reachable from the entry.
 * 2. The exact set of non-relative specifiers that graph imports.
 * 3. The exact runtime export list of the entry.
 *
 * Each is an equality, not a subset check, on purpose: growing any of the
 * three should be a decision someone has to consciously reverse, not a side
 * effect of an unrelated import. `scripts/check-agent-memory-entry.mjs`
 * re-checks the same properties against the built bundle, where tree-shaking
 * and the tsup entry boundary — not this scan — decide what actually ships.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as agentMemoryEntry from '../agent-memory/index';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = path.join(SRC_ROOT, 'agent-memory', 'index.ts');

/** Drops comments so a scan sees declarations, not prose about declarations. */
function code(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|[^:])\/\/.*$/gm, '$1');
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`unresolved relative import ${specifier} from ${path.relative(SRC_ROOT, fromFile)}`);
}

interface ModuleGraph {
  readonly modules: readonly string[];
  readonly external: readonly string[];
  readonly sources: ReadonlyMap<string, string>;
}

function walkModuleGraph(entry: string): ModuleGraph {
  const sources = new Map<string, string>();
  const external = new Set<string>();
  const visit = (file: string): void => {
    const relative = path.relative(SRC_ROOT, file);
    if (sources.has(relative)) return;
    const text = code(readFileSync(file, 'utf8'));
    sources.set(relative, text);
    for (const [, specifier] of text.matchAll(/from\s+'([^']+)'/g)) {
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) visit(resolveRelative(file, specifier));
      else external.add(specifier);
    }
    for (const [, specifier] of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) {
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) visit(resolveRelative(file, specifier));
      else external.add(specifier);
    }
  };
  visit(entry);
  return { modules: [...sources.keys()].sort(), external: [...external].sort(), sources };
}

const GRAPH = walkModuleGraph(ENTRY);

describe('the embedded agent-memory entry module graph', () => {
  it('reaches exactly the memory authority, its filesystem backends, and the Agent-home constant', () => {
    // `agent-home.ts` and its `path-mutation-gate` / `secure-dir` /
    // `exec-runner` tail are here for one value: `AGENT_HOME_INTERNAL_DIRECTORY`,
    // which `daemon/agent-memory.ts` imports to place its internal audit state.
    // They are inert at runtime for an embedded host — nothing on this entry
    // calls them — and splitting that constant into a leaf module would be a
    // change to the Agent-home boundary, not to this entry. If this list needs
    // to grow, say why in the same commit.
    expect(GRAPH.modules).toEqual([
      'agent-home.ts',
      'agent-memory/index.ts',
      'bin/agent-memory-mcp-server.ts',
      'daemon/agent-memory-filesystem.ts',
      'daemon/agent-memory-fs-helper.ts',
      'daemon/agent-memory.ts',
      'daemon/memory-guidance.ts',
      'daemon/path-mutation-gate.ts',
      'lifecycle/exec-runner.ts',
      'util/atomic-write.ts',
      'util/secure-dir.ts',
    ]);
  });

  it('imports @byok-sdk/protocol and node builtins, and nothing else', () => {
    // No `ws`. No `@byok-sdk/core`. No runtime adapter package. A host that
    // installs `@byok-sdk/client` for memory alone pays for the protocol
    // schemas and the Node standard library.
    expect(GRAPH.external).toEqual([
      '@byok-sdk/protocol',
      'node:child_process',
      'node:crypto',
      'node:fs',
      'node:net',
      'node:os',
      'node:path',
      'node:readline',
    ]);
  });

  it('never reaches the daemon composition, the control client, or a transport', () => {
    const forbidden = [
      'create-daemon',
      'control-client',
      'control-server',
      'control-protocol',
      'long-poll-transport',
      'connection-manager',
      'http-client',
      'assertion-client',
      'task-runner',
      'auth-manager',
      'observer',
      'presence-publisher',
    ];
    for (const module of GRAPH.modules) {
      for (const name of forbidden) {
        expect(module, `${module} is a forbidden daemon module`).not.toContain(name);
      }
    }
  });

  it('names no control-client or daemon composition symbol in any reachable source', () => {
    for (const [module, text] of GRAPH.sources) {
      expect(text, module).not.toContain('connectControlClient');
      expect(text, module).not.toMatch(/\bControlClient\b/);
      expect(text, module).not.toContain('createDaemon');
      expect(text, module).not.toMatch(/from\s+'ws'/);
    }
  });

  it('scans a non-trivial graph', () => {
    // The equality assertions above prove nothing if the walker silently
    // stopped at the entry file.
    expect(GRAPH.modules.length).toBeGreaterThan(5);
    expect(GRAPH.sources.get('daemon/agent-memory.ts')).toContain('class AgentMemoryService');
  });
});

describe('the embedded agent-memory public surface', () => {
  it('exports exactly the composition set an embedded host needs', () => {
    expect(Object.keys(agentMemoryEntry).sort()).toEqual([
      'AGENT_MEMORY_GUIDANCE',
      'AGENT_MEMORY_RECALL_TOOL_NAME',
      'AGENT_MEMORY_SAVE_TOOL_NAME',
      'AgentMemoryError',
      'AgentMemoryRevisionConflictError',
      'AgentMemoryService',
      'captureAgentMemorySnapshot',
      'isAgentMemoryFilesystemHelperSupported',
      'isAgentMemorySecureFilesystemAvailable',
      'openAgentMemoryFilesystemHelper',
      'prependAgentMemoryGuidance',
      'serveAgentMemoryMcpOverStdio',
      'validateAgentMemoryPath',
    ]);
  });

  it('exposes no hosted-projection surface', () => {
    // Projection is a network surface and its credential-blind transport does
    // not exist yet. An embedded host gets `captureAgentMemorySnapshot` and no
    // way to send the result anywhere from this package.
    const entrySource = code(readFileSync(ENTRY, 'utf8'));
    for (const symbol of [
      'snapshotAndProjectAgentMemory',
      'AgentMemoryRedactedOutbox',
      'AgentMemoryHostedProjection',
      'AgentMemoryProjectionPort',
      'AgentMemoryProjectionGrant',
      'AgentMemoryRedactor',
      'AGENT_MEMORY_OUTBOX_FILENAME',
    ]) {
      expect(Object.keys(agentMemoryEntry), symbol).not.toContain(symbol);
      expect(entrySource, symbol).not.toContain(symbol);
    }
  });

  it('touches no provider credential surface', () => {
    // The credential-isolation invariant, restated where it is cheapest to
    // check: the memory surface never had a provider credential in it, and
    // this entry must not be the thing that introduces one.
    for (const [module, text] of GRAPH.sources) {
      expect(text, module).not.toMatch(/\bdevice-credential-store\b/);
      expect(text, module).not.toMatch(/\bproviderCredential\b/);
      expect(text, module).not.toMatch(/\bapiKey\b/);
    }
  });

  it('keeps the daemon-only Windows fail-closed gate exactly as the daemon uses it', () => {
    // Platform semantics are inherited, not restated: `win32` never has a
    // secure backend, with or without a host-configured helper.
    const gate = GRAPH.sources.get('daemon/agent-memory.ts') ?? '';
    expect(gate).toContain("process.platform === 'linux'");
    expect(gate).toContain("process.platform === 'darwin'");
    expect(gate).not.toContain("process.platform === 'win32'");
    expect(typeof agentMemoryEntry.isAgentMemorySecureFilesystemAvailable(false)).toBe('boolean');
    if (process.platform === 'win32') {
      expect(agentMemoryEntry.isAgentMemorySecureFilesystemAvailable(true)).toBe(false);
    }
  });

  it('rejects an inexact task context before touching the filesystem', () => {
    const service = new agentMemoryEntry.AgentMemoryService({
      taskId: '',
      tenantId: 'tenant',
      deviceId: 'device',
      agentRef: { agentId: 'agent', profileRevision: 'rev' },
      sessionRef: 'session',
      runtimeId: 'runtime',
      canonicalHome: '/nonexistent/home',
      leaseId: 'lease',
      homeIdentity: { dev: 1n, ino: 2n },
    });
    return expect(service.recall({ path: 'MEMORY.md' })).rejects.toBeInstanceOf(agentMemoryEntry.AgentMemoryError);
  });
});
