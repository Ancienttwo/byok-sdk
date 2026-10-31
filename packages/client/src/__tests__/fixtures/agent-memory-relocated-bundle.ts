import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveAgentMemoryFilesystemHelper } from '../../util/agent-memory-helper-release';
import { openAgentMemoryFilesystemHelper } from '../../daemon/agent-memory-fs-helper';
import { AgentMemoryService } from '../../daemon/agent-memory';

const assetRoot = process.argv[2]!;
const canonicalHome = path.join(process.argv[3]!, 'home');
mkdirSync(canonicalHome, { recursive: true });
const stat = statSync(canonicalHome, { bigint: true });
const homeIdentity = { dev: stat.dev, ino: stat.ino };
const helperBin = resolveAgentMemoryFilesystemHelper(assetRoot);
const filesystem = await openAgentMemoryFilesystemHelper({ helperBin, assetRoot, canonicalHome, homeIdentity });
try {
  const memory = new AgentMemoryService({ taskId: 'task', tenantId: 'tenant', deviceId: 'device', sessionRef: 'session', runtimeId: 'pi',
    leaseId: 'isolated-fixture', agentRef: { agentId: 'one', profileRevision: '1' }, canonicalHome, homeIdentity, filesystem });
  const old = await filesystem.read('MEMORY.md', 8192);
  await memory.save({ op: 'replace', path: 'MEMORY.md', expectedRevision: old.revision, content: 'relocated SDK helper' });
  console.log(JSON.stringify(await memory.recall({ path: 'MEMORY.md' })));
} finally { await filesystem.close(); }
