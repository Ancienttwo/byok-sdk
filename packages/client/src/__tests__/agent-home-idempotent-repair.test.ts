import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentHomeManager,
  type AgentHomeProjection,
  type AgentHomeProjectionApplyInput,
} from '../agent-home';

const roots: string[] = [];
const HASH = `sha256:${'a'.repeat(64)}`;

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-agent-home-idempotent-repair-'));
  roots.push(root);
  return root;
}

function desired(requestId: string) {
  return {
    requestId,
    agentRef: { agentId: 'repairable-agent', profileRevision: '7' },
    projectionHash: HASH,
    projection: { schemaVersion: 'host.opaque.v1', displayName: 'Repairable Agent' },
  } as const;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Agent-home exact desired-state repair', () => {
  it('runs an opted-in idempotent ensure before returning idempotent', async () => {
    const root = await makeRoot();
    let applyCalls = 0;
    let ensureCalls = 0;
    const writeProjection = async ({ cwd, projection }: AgentHomeProjectionApplyInput) => {
      await fs.writeFile(path.join(cwd, 'profile.json'), `${JSON.stringify(projection)}\n`, 'utf8');
    };
    const projection = {
      apply: async (input: AgentHomeProjectionApplyInput) => {
        applyCalls += 1;
        await writeProjection(input);
      },
      ensure: async (input: AgentHomeProjectionApplyInput) => {
        ensureCalls += 1;
        await writeProjection(input);
      },
    } as AgentHomeProjection;
    const manager = new AgentHomeManager({ hostStorageRoot: root, projection });

    await expect(manager.project(desired('11111111-1111-4111-8111-111111111111'))).resolves.toBe('applied');
    const home = path.join(await fs.realpath(root), 'agents', 'repairable-agent');
    const profilePath = path.join(home, 'profile.json');
    await fs.unlink(profilePath);

    await expect(manager.project(desired('22222222-2222-4222-8222-222222222222')))
      .resolves.toBe('idempotent');
    expect(JSON.parse(await fs.readFile(profilePath, 'utf8'))).toEqual(desired('').projection);
    expect(applyCalls).toBe(1);
    expect(ensureCalls).toBe(1);
  });
});
