import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentHomeManager } from '../agent-home';
import { AgentMemoryService, captureAgentMemorySnapshot, type AgentMemoryTaskContext } from '../daemon/agent-memory';
import {
  isAgentMemoryFilesystemHelperSupported,
  openAgentMemoryFilesystemHelper,
} from '../daemon/agent-memory-fs-helper';

const roots: string[] = [];
const helperBin = process.env.BYOK_TEST_AGENT_MEMORY_FS_BIN;
const itWithHelper = helperBin !== undefined && isAgentMemoryFilesystemHelperSupported() ? it : it.skip;

async function temporaryRoot(prefix: string): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Agent memory external filesystem helper', () => {
  itWithHelper('binds the leased root and preserves MCP, snapshot, audit, and bounded log semantics', async () => {
    const hostStorageRoot = await temporaryRoot('byok-agent-memory-helper-host-');
    const outside = await temporaryRoot('byok-agent-memory-helper-outside-');
    const binding = await new AgentHomeManager({ hostStorageRoot }).prepare({ agentId: 'helper-agent', profileRevision: 'p1' });
    const filesystem = await openAgentMemoryFilesystemHelper({
      helperBin: helperBin!,
      canonicalHome: binding.resolution.canonicalHome,
      homeIdentity: binding.lease.homeIdentity,
    });
    const context: AgentMemoryTaskContext = {
      taskId: 'helper-task',
      tenantId: 'helper-tenant',
      deviceId: 'helper-device',
      agentRef: binding.resolution.agentRef,
      sessionRef: 'helper-session',
      runtimeId: 'codex',
      canonicalHome: binding.resolution.canonicalHome,
      leaseId: binding.lease.leaseId,
      homeIdentity: binding.lease.homeIdentity,
      filesystem,
    };

    try {
      const service = new AgentMemoryService(context);
      const initial = await service.recall({ path: 'MEMORY.md' });
      const saved = await service.save({
        op: 'replace',
        path: 'MEMORY.md',
        expectedRevision: initial.revision,
        content: 'local durable value',
      });
      expect(saved.deleted).toBe(false);
      expect((await service.recall({ path: 'MEMORY.md' })).content).toBe('local durable value');

      await fs.writeFile(path.join(binding.resolution.canonicalHome, 'notes', 'topic.md'), 'snapshot note', 'utf8');
      const snapshot = await captureAgentMemorySnapshot(context);
      expect(snapshot.files.map((file) => file.path)).toEqual(['MEMORY.md', 'notes/topic.md']);

      const audit = await fs.readFile(path.join(binding.resolution.canonicalHome, '.byok', 'agent-memory-audit-v1.jsonl'), 'utf8');
      expect(audit).toContain('"kind":"save"');
      expect(audit).not.toContain('local durable value');

      const chunk = 'x'.repeat(200 * 1024);
      await filesystem.append('.byok/helper-log.jsonl', chunk, 1024 * 1024);
      await filesystem.append('.byok/helper-log.jsonl', chunk, 1024 * 1024);
      const log = await filesystem.read('.byok/helper-log.jsonl', 1024 * 1024);
      expect(log.byteCount).toBe(400 * 1024);
      expect(log.content).toBe(chunk + chunk);

      await fs.writeFile(path.join(outside, 'sentinel.md'), 'outside sentinel', 'utf8');
      await fs.symlink(path.join(outside, 'sentinel.md'), path.join(binding.resolution.canonicalHome, 'notes', 'linked.md'));
      await expect(service.recall({ path: 'notes/linked.md' })).rejects.toThrow('unsafe_path');
      expect(await fs.readFile(path.join(outside, 'sentinel.md'), 'utf8')).toBe('outside sentinel');
    } finally {
      await filesystem.close();
      await binding.lease.release();
    }
  });

  itWithHelper('rejects a mismatched leased-root identity before exposing filesystem authority', async () => {
    const hostStorageRoot = await temporaryRoot('byok-agent-memory-helper-identity-');
    const binding = await new AgentHomeManager({ hostStorageRoot }).prepare({ agentId: 'identity-agent', profileRevision: 'p1' });
    try {
      await expect(openAgentMemoryFilesystemHelper({
        helperBin: helperBin!,
        canonicalHome: binding.resolution.canonicalHome,
        homeIdentity: { dev: binding.lease.homeIdentity.dev, ino: binding.lease.homeIdentity.ino + 1n },
      })).rejects.toThrow('root_identity_mismatch');
    } finally {
      await binding.lease.release();
    }
  });
});
