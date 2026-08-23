import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentHomeLayout } from '../agent-home';
import {
  AGENT_CONTENT_READ_CAPABILITIES,
  AgentContentReadPolicyEngine,
  AgentContentReadPolicyError,
  AgentContentReadRequestError,
  createAgentContentReadPolicy,
  type AgentContentReadPolicy,
  type AgentContentReadRequest,
  type AgentContentReadSurface,
  type AgentContentSessionIdentity,
} from '../daemon/agent-content-read';
import { AgentContentAuditStore, AgentContentAuditStoreError } from '../daemon/agent-content-audit-store';

const roots: string[] = [];
const FIXTURE_ROOT = path.dirname(fileURLToPath(new URL('./fixtures/agent-content-read/opaque-note.txt', import.meta.url)));

async function makeRoot(prefix = 'byok-content-read-'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const agentRef = { agentId: 'agent-one', profileRevision: 'profile-1' } as const;

function enabledPolicy(
  surface: AgentContentReadSurface,
  root: AgentContentReadPolicy['root'],
  overrides: Partial<AgentContentReadPolicy> = {},
): AgentContentReadPolicy {
  return createAgentContentReadPolicy({
    enabled: true,
    capability: AGENT_CONTENT_READ_CAPABILITIES[surface],
    root,
    policyRevision: 'policy-1',
    maxBytes: 1024,
    maxTextBytes: 512,
    allowedMimeTypes: ['text/plain', 'text/markdown', 'application/octet-stream'],
    textMimeTypes: ['text/plain', 'text/markdown'],
    ...overrides,
  });
}

function request(
  surface: AgentContentReadSurface,
  relativeTarget: string,
  overrides: Partial<AgentContentReadRequest> = {},
): AgentContentReadRequest {
  return {
    requestId: `request-${Math.random().toString(16).slice(2)}`,
    actor: { kind: 'user', id: 'actor-1' },
    tenantId: 'tenant-1',
    deviceId: 'device-1',
    agentRef,
    surface,
    relativeTarget,
    mimeType: 'text/plain',
    capability: AGENT_CONTENT_READ_CAPABILITIES[surface],
    policyRevision: 'policy-1',
    decodeAs: 'utf8',
    ...overrides,
  };
}

function transcriptIdentity(cwd: string): AgentContentSessionIdentity {
  return {
    agentRef,
    sessionRef: 'session-1',
    runtimeId: 'pi',
    cwd,
  };
}

async function makeEngine(options: {
  readonly root: string;
  readonly policies: Partial<Record<AgentContentReadSurface, AgentContentReadPolicy | 'disabled'>>;
  readonly capabilities?: readonly string[];
  readonly runtimeAllowlistedRoots?: readonly string[];
  readonly resolveTranscriptIdentity?: AgentContentReadPolicyEngine['options']['resolveTranscriptIdentity'];
}): Promise<{
  engine: AgentContentReadPolicyEngine;
  layout: AgentHomeLayout;
  auditPath: string;
}> {
  const layout = new AgentHomeLayout(options.root);
  const auditPath = path.join(options.root, 'audit', 'content-reads.jsonl');
  const auditStore = new AgentContentAuditStore(auditPath);
  const policies = {
    workspace: 'disabled' as const,
    transcript: 'disabled' as const,
    artifact: 'disabled' as const,
    ...options.policies,
  };
  const engine = new AgentContentReadPolicyEngine({
    agentHomeLayout: layout,
    policies,
    capabilities: options.capabilities ?? Object.values(AGENT_CONTENT_READ_CAPABILITIES),
    runtimeAllowlistedRoots: options.runtimeAllowlistedRoots,
    auditStore,
    resolveTranscriptIdentity: options.resolveTranscriptIdentity,
  });
  return { engine, layout, auditPath };
}

describe('Agent content-read policy engine', () => {
  it('reads one canonical Agent-home target only after explicit policy, capability, MIME and UTF-8 opt-in', async () => {
    const root = await makeRoot();
    const { engine, layout, auditPath } = await makeEngine({
      root,
      policies: { workspace: enabledPolicy('workspace', { kind: 'agent-home' }) },
    });
    const home = (await layout.resolve(agentRef)).canonicalHome;
    await fs.mkdir(path.join(home, 'notes'), { recursive: true });
    await fs.writeFile(path.join(home, 'notes', 'readme.md'), 'hello explicit read\n', 'utf8');

    const result = await engine.read(request('workspace', 'notes/readme.md', { mimeType: 'text/markdown' }));
    expect(result.decision).toBe('allow');
    if (result.decision !== 'allow') throw new Error('expected allowed read');
    if (result.text === undefined) throw new Error('expected explicit UTF-8 text');
    expect(result.text).toBe('hello explicit read\n');
    expect(result.byteCount).toBe(Buffer.byteLength(result.text, 'utf8'));
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt).toMatchObject({
      requestId: result.receipt.requestId,
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      agentRef,
      relativeTarget: 'notes/readme.md',
      policyRevision: 'policy-1',
      decision: 'allow',
      byteCount: result.byteCount,
    });
    expect(result.receipt).not.toHaveProperty('content');
    expect(JSON.parse(await fs.readFile(auditPath, 'utf8'))).not.toHaveProperty('content');

    const restarted = new AgentContentAuditStore(auditPath);
    await expect(restarted.readback()).resolves.toHaveLength(1);
    await expect(restarted.readback()).resolves.toMatchObject([
      { relativeTarget: 'notes/readme.md', decision: 'allow', contentHash: result.contentHash },
    ]);
  });

  it('keeps all three surfaces disabled by default and records typed policy/capability/revision denials', async () => {
    const root = await makeRoot();
    const { engine, auditPath } = await makeEngine({ root, policies: {} });
    for (const [index, surface] of ['workspace', 'transcript', 'artifact'].entries()) {
      const result = await engine.read(request(surface as AgentContentReadSurface, `file-${index}.txt`));
      expect(result).toMatchObject({ decision: 'deny', reason: 'policy-disabled' });
      expect(result).not.toHaveProperty('content');
    }
    const missingCapability = await makeEngine({
      root: await makeRoot(),
      policies: { workspace: enabledPolicy('workspace', { kind: 'agent-home' }) },
      capabilities: [],
    });
    const deniedCapability = await missingCapability.engine.read(request('workspace', 'readme.txt'));
    expect(deniedCapability).toMatchObject({ decision: 'deny', reason: 'capability-missing' });
    const enabled = await makeEngine({
      root: await makeRoot(),
      policies: { workspace: enabledPolicy('workspace', { kind: 'agent-home' }) },
    });
    const staleRevision = await enabled.engine.read(request('workspace', 'readme.txt', { policyRevision: 'old-policy' }));
    expect(staleRevision).toMatchObject({ decision: 'deny', reason: 'policy-revision-mismatch' });
    expect(await new AgentContentAuditStore(auditPath).readAll()).toHaveLength(3);
  });

  it('rejects traversal, absolute paths, dot segments and SDK-reserved sensitive names before reading', async () => {
    const root = await makeRoot();
    const { engine, layout } = await makeEngine({
      root,
      policies: { workspace: enabledPolicy('workspace', { kind: 'agent-home' }) },
    });
    const home = (await layout.resolve(agentRef)).canonicalHome;
    await fs.writeFile(path.join(home, 'visible.txt'), 'visible', 'utf8');
    await fs.writeFile(path.join(home, 'MEMORY.md'), 'private', 'utf8');
    const cases = [
      ['../outside.txt', 'dot-segment'],
      ['/etc/passwd', 'absolute-target'],
      ['C:/outside.txt', 'absolute-target'],
      ['notes/../visible.txt', 'dot-segment'],
      ['MEMORY.md', 'sensitive-name'],
      ['.byok/runtime-sessions/anything.jsonl', 'sensitive-name'],
      ['visible.txt\\other', 'non-relative-target'],
    ] as const;
    for (const [target, reason] of cases) {
      const result = await engine.read(request('workspace', target));
      expect(result).toMatchObject({ decision: 'deny', reason });
    }
  });

  (process.platform === 'win32' ? it.skip : it)('rejects symlink targets and symlink ancestors even when they resolve back inside the Agent home', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const { engine, layout } = await makeEngine({
      root,
      policies: { workspace: enabledPolicy('workspace', { kind: 'agent-home' }) },
    });
    const home = (await layout.resolve(agentRef)).canonicalHome;
    await fs.writeFile(path.join(outside, 'outside.txt'), 'outside', 'utf8');
    await fs.symlink(path.join(outside, 'outside.txt'), path.join(home, 'link.txt'));
    await fs.mkdir(path.join(home, 'real-dir'));
    await fs.writeFile(path.join(home, 'real-dir', 'inside.txt'), 'inside', 'utf8');
    await fs.symlink(path.join(home, 'real-dir'), path.join(home, 'alias-dir'), 'dir');

    await expect(engine.read(request('workspace', 'link.txt'))).resolves.toMatchObject({ decision: 'deny', reason: 'path-escape' });
    await expect(engine.read(request('workspace', 'alias-dir/inside.txt'))).resolves.toMatchObject({ decision: 'deny', reason: 'symlink' });
  });

  it('enforces positive pre-read byte bounds, exact MIME allowlists and fatal bounded decoding', async () => {
    const root = await makeRoot();
    const { engine, layout } = await makeEngine({
      root,
      policies: {
        workspace: enabledPolicy('workspace', { kind: 'agent-home' }, { maxBytes: 8, maxTextBytes: 4 }),
      },
    });
    const home = (await layout.resolve(agentRef)).canonicalHome;
    await fs.writeFile(path.join(home, 'large.txt'), '12345', 'utf8');
    await fs.writeFile(path.join(home, 'bad.txt'), Buffer.from([0xff, 0xfe]));
    await fs.writeFile(path.join(home, 'binary.bin'), Buffer.from([0, 1, 2]));

    await expect(engine.read(request('workspace', 'large.txt'))).resolves.toMatchObject({ decision: 'deny', reason: 'byte-limit' });
    await expect(engine.read(request('workspace', 'binary.bin', { mimeType: 'application/pdf', decodeAs: 'bytes' })))
      .resolves.toMatchObject({ decision: 'deny', reason: 'mime-not-allowlisted' });
    await expect(engine.read(request('workspace', 'bad.txt'))).resolves.toMatchObject({ decision: 'deny', reason: 'text-decode-failed' });
    await expect(engine.read(request('workspace', 'binary.bin', { mimeType: 'application/octet-stream', decodeAs: 'bytes' })))
      .resolves.toMatchObject({ decision: 'allow', byteCount: 3 });
  });

  it('requires exact transcript AgentRef/profileRevision/session/runtime/cwd identity', async () => {
    const root = await makeRoot();
    const layout = new AgentHomeLayout(root);
    const home = (await layout.resolve(agentRef)).canonicalHome;
    const identity = transcriptIdentity(home);
    const engine = new AgentContentReadPolicyEngine({
      agentHomeLayout: layout,
      policies: {
        workspace: 'disabled',
        artifact: 'disabled',
        transcript: enabledPolicy('transcript', { kind: 'agent-home' }, { expectedTranscriptIdentity: identity }),
      },
      capabilities: [AGENT_CONTENT_READ_CAPABILITIES.transcript],
      auditStore: new AgentContentAuditStore(path.join(root, 'audit', 'content-reads.jsonl')),
    });
    await fs.mkdir(path.join(home, 'sessions'));
    await fs.writeFile(path.join(home, 'sessions', 'trace.txt'), 'trace', 'utf8');
    const allowed = await engine.read(request('transcript', 'sessions/trace.txt', {
      session: identity,
    }));
    expect(allowed.decision).toBe('allow');

    for (const session of [
      { ...identity, agentRef: { ...agentRef, profileRevision: 'profile-2' } },
      { ...identity, sessionRef: 'session-2' },
      { ...identity, runtimeId: 'codex' },
      { ...identity, cwd: path.join(home, 'other-cwd') },
    ]) {
      const denied = await engine.read(request('transcript', 'sessions/trace.txt', { session }));
      expect(denied).toMatchObject({ decision: 'deny', reason: 'identity-mismatch' });
    }
  });

  it('binds runtime reads to an explicit allowlisted root and never infers MIME from the filename', async () => {
    const { engine } = await makeEngine({
      root: await makeRoot(),
      runtimeAllowlistedRoots: [FIXTURE_ROOT],
      policies: { artifact: enabledPolicy('artifact', { kind: 'runtime-allowlisted', root: FIXTURE_ROOT }) },
    });
    const allowed = await engine.read(request('artifact', 'opaque-note.txt', {
      mimeType: 'text/plain',
    }));
    expect(allowed).toMatchObject({ decision: 'allow', relativeTarget: 'opaque-note.txt' });
    const wrongMime = await engine.read(request('artifact', 'opaque-note.txt', { mimeType: 'application/pdf' }));
    expect(wrongMime).toMatchObject({ decision: 'deny', reason: 'mime-not-allowlisted' });

    const notAllowlisted = await makeEngine({
      root: await makeRoot(),
      policies: { artifact: enabledPolicy('artifact', { kind: 'runtime-allowlisted', root: FIXTURE_ROOT }) },
      runtimeAllowlistedRoots: [],
    });
    await expect(notAllowlisted.engine.read(request('artifact', 'opaque-note.txt')))
      .resolves.toMatchObject({ decision: 'deny', reason: 'root-not-allowlisted' });
  });

  it('allows resolver-backed transcript admission and emits only append-only content-free receipts across concurrent requests', async () => {
    const root = await makeRoot();
    const layout = new AgentHomeLayout(root);
    const home = (await layout.resolve(agentRef)).canonicalHome;
    await fs.writeFile(path.join(home, 'log.txt'), 'trace-content', 'utf8');
    const auditPath = path.join(root, 'audit', 'receipts.jsonl');
    const auditStore = new AgentContentAuditStore(auditPath);
    const identity = transcriptIdentity(home);
    const engine = new AgentContentReadPolicyEngine({
      agentHomeLayout: layout,
      policies: {
        workspace: 'disabled',
        artifact: 'disabled',
        transcript: enabledPolicy('transcript', { kind: 'agent-home' }),
      },
      capabilities: [AGENT_CONTENT_READ_CAPABILITIES.transcript],
      auditStore,
      resolveTranscriptIdentity: async () => identity,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => engine.read(request('transcript', 'log.txt', {
        requestId: `concurrent-${index}`,
        session: identity,
      }))),
    );
    expect(results.every((result) => result.decision === 'allow')).toBe(true);
    const receipts = await new AgentContentAuditStore(auditPath).readback();
    expect(receipts).toHaveLength(8);
    const raw = await fs.readFile(auditPath, 'utf8');
    expect(raw).not.toContain('trace-content');
    expect(raw).toContain(home); // exact transcript cwd identity is required in the receipt
  });

  it('fails closed when the durable audit ledger is widened or corrupted', async () => {
    const root = await makeRoot();
    const auditPath = path.join(root, 'audit', 'receipts.jsonl');
    const store = new AgentContentAuditStore(auditPath);
    await expect(store.append({
      version: 1,
      requestId: 'request-1',
      actor: { kind: 'user', id: 'actor-1' },
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      agentRef,
      surface: 'workspace',
      relativeTarget: 'notes/readme.md',
      policyRevision: 'policy-1',
      byteCount: 0,
      decision: 'deny',
      reason: 'policy-disabled',
      recordedAt: new Date().toISOString(),
    })).resolves.toMatchObject({ decision: 'deny' });
    await fs.appendFile(auditPath, JSON.stringify({ content: 'secret body' }) + '\n', 'utf8');
    await expect(new AgentContentAuditStore(auditPath).readback()).rejects.toBeInstanceOf(AgentContentAuditStoreError);
  });

  it('reuses one durable receipt for an exact requestId replay and fails closed on a conflicting reuse after restart', async () => {
    const root = await makeRoot();
    const auditPath = path.join(root, 'audit', 'receipts.jsonl');
    const receipt = {
      version: 1 as const,
      requestId: 'request-replayed',
      actor: { kind: 'user' as const, id: 'actor-1' },
      tenantId: 'tenant-1',
      deviceId: 'device-1',
      agentRef,
      surface: 'workspace' as const,
      relativeTarget: 'notes/readme.md',
      policyRevision: 'policy-1',
      byteCount: 0,
      decision: 'deny' as const,
      reason: 'policy-disabled' as const,
      recordedAt: '2026-08-23T00:00:00.000Z',
    };
    const first = new AgentContentAuditStore(auditPath);
    await expect(first.append(receipt)).resolves.toEqual(receipt);

    const restarted = new AgentContentAuditStore(auditPath);
    const replay = await restarted.append({ ...receipt, recordedAt: '2026-08-23T00:01:00.000Z' });
    expect(replay).toEqual(receipt);
    await expect(restarted.readback()).resolves.toEqual([receipt]);
    await expect(restarted.append({ ...receipt, relativeTarget: 'notes/other.md' }))
      .rejects.toBeInstanceOf(AgentContentAuditStoreError);
  });

  it('rejects invalid policy/request shapes instead of inventing roots, MIME or bounds', async () => {
    expect(() => createAgentContentReadPolicy({
      enabled: true,
      capability: AGENT_CONTENT_READ_CAPABILITIES.workspace,
      root: { kind: 'agent-home' },
      policyRevision: 'policy-1',
      maxBytes: 0,
      maxTextBytes: 1,
      allowedMimeTypes: ['text/plain'],
      textMimeTypes: ['text/plain'],
    })).toThrow(AgentContentReadPolicyError);
    expect(() => createAgentContentReadPolicy({
      enabled: true,
      capability: AGENT_CONTENT_READ_CAPABILITIES.workspace,
      root: { kind: 'agent-home' },
      policyRevision: 'policy-1',
      maxBytes: 1,
      maxTextBytes: 1,
      allowedMimeTypes: ['text/*'],
      textMimeTypes: ['text/*'],
    })).toThrow(AgentContentReadPolicyError);

    const root = await makeRoot();
    const { engine } = await makeEngine({
      root,
      policies: { workspace: enabledPolicy('workspace', { kind: 'agent-home' }) },
    });
    await expect(engine.read(request('workspace', 'visible.txt', { mimeType: '' }))).rejects.toBeInstanceOf(AgentContentReadRequestError);
  });
});
