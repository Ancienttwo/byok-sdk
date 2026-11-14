import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveAgentMemoryFilesystemHelper } from '../../util/agent-memory-helper-release';
import { openAgentMemoryFilesystemHelper } from '../../daemon/agent-memory-fs-helper';
import { AgentMemoryService } from '../../daemon/agent-memory';
import { memoryTestTiming } from './agent-memory-timing';

process.env.BYOK_MEMORY_TIMING = '1';
const timing = memoryTestTiming('bundle.child');
timing('begin');

const assetRoot = process.argv[2]!;
const canonicalHome = path.join(process.argv[3]!, 'home');
mkdirSync(path.join(canonicalHome, 'notes'), { recursive: true });
const stat = statSync(canonicalHome, { bigint: true });
const homeIdentity = { dev: stat.dev, ino: stat.ino };
const helperBin = resolveAgentMemoryFilesystemHelper(assetRoot);
timing('resolved');
const filesystem = await openAgentMemoryFilesystemHelper({ helperBin, assetRoot, canonicalHome, ancestorRoot: process.argv[3]!, homeIdentity });
timing('opened');
try {
  const memory = new AgentMemoryService({ taskId: 'task', tenantId: 'tenant', deviceId: 'device', sessionRef: 'session', runtimeId: 'pi',
    leaseId: 'isolated-fixture', agentRef: { agentId: 'one', profileRevision: '1' }, canonicalHome, homeIdentity, filesystem });
  const old = await filesystem.read('MEMORY.md', 8192);
  timing('read');
  await memory.save({ op: 'replace', path: 'MEMORY.md', expectedRevision: old.revision, content: 'relocated SDK helper' });
  timing('saved');
  console.log(JSON.stringify(await memory.recall({ path: 'MEMORY.md' })));
  timing('recalled');
} finally {
  timing('close.begin');
  await filesystem.close();
  timing('closed');
}
