import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_HOME_PROJECTION_STATE_FILE,
  AgentHomeBusyError,
  AgentHomeManager,
  createAgentHomeProjectionConsumer,
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

async function paths(root: string) {
  const home = path.join(await fs.realpath(root), 'agents', 'repairable-agent');
  return {
    home,
    profile: path.join(home, 'profile.json'),
    state: path.join(home, '.byok', AGENT_HOME_PROJECTION_STATE_FILE),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Agent-home exact desired-state repair', () => {
  it('re-runs the idempotent product consumer before returning idempotent', async () => {
    const root = await makeRoot();
    let applyCalls = 0;
    const projection = createAgentHomeProjectionConsumer(async ({ cwd, projection }) => {
      applyCalls += 1;
      await fs.writeFile(path.join(cwd, 'profile.json'), `${JSON.stringify(projection)}\n`, 'utf8');
    });
    const manager = new AgentHomeManager({ hostStorageRoot: root, projection });

    await expect(manager.project(desired('11111111-1111-4111-8111-111111111111'))).resolves.toBe('applied');
    const homePaths = await paths(root);
    await fs.unlink(homePaths.profile);

    await expect(manager.project(desired('22222222-2222-4222-8222-222222222222')))
      .resolves.toBe('idempotent');
    expect(JSON.parse(await fs.readFile(homePaths.profile, 'utf8'))).toEqual(desired('').projection);
    expect(applyCalls).toBe(2);
  });

  it('recreates the whole canonical home as a new local apply when ordering state is also lost', async () => {
    const root = await makeRoot();
    const projection = createAgentHomeProjectionConsumer(async ({ cwd, projection }) => {
      await fs.writeFile(path.join(cwd, 'profile.json'), `${JSON.stringify(projection)}\n`, 'utf8');
    });
    const manager = new AgentHomeManager({ hostStorageRoot: root, projection });

    await expect(manager.project(desired('11111111-1111-4111-8111-111111111111'))).resolves.toBe('applied');
    const homePaths = await paths(root);
    await fs.rm(homePaths.home, { recursive: true });

    await expect(manager.project(desired('22222222-2222-4222-8222-222222222222')))
      .resolves.toBe('applied');
    expect(JSON.parse(await fs.readFile(homePaths.profile, 'utf8'))).toEqual(desired('').projection);
    expect(await fs.readFile(path.join(homePaths.home, 'MEMORY.md'), 'utf8')).toBe('');
    expect((await fs.stat(path.join(homePaths.home, 'notes'))).isDirectory()).toBe(true);
  });

  it('keeps exact replay unacknowledged and ordering state unchanged when the consumer fails', async () => {
    const root = await makeRoot();
    let fail = false;
    const projection = createAgentHomeProjectionConsumer(async ({ cwd, projection }) => {
      if (fail) throw new Error('product ensure failed');
      await fs.writeFile(path.join(cwd, 'profile.json'), `${JSON.stringify(projection)}\n`, 'utf8');
    });
    const manager = new AgentHomeManager({ hostStorageRoot: root, projection });

    await expect(manager.project(desired('11111111-1111-4111-8111-111111111111'))).resolves.toBe('applied');
    const homePaths = await paths(root);
    const priorState = await fs.readFile(homePaths.state, 'utf8');
    await fs.unlink(homePaths.profile);
    fail = true;

    await expect(manager.project(desired('22222222-2222-4222-8222-222222222222')))
      .rejects.toThrow('product ensure failed');
    expect(await fs.readFile(homePaths.state, 'utf8')).toBe(priorState);
    await expect(fs.access(homePaths.profile)).rejects.toThrow();

    fail = false;
    await expect(manager.project(desired('22222222-2222-4222-8222-222222222222')))
      .resolves.toBe('idempotent');
    expect(JSON.parse(await fs.readFile(homePaths.profile, 'utf8'))).toEqual(desired('').projection);
  });

  it('serializes exact repair with an Agent execution lease on the same canonical home', async () => {
    const root = await makeRoot();
    const projection = createAgentHomeProjectionConsumer(async () => {});
    const manager = new AgentHomeManager({ hostStorageRoot: root, projection });
    await expect(manager.project(desired('11111111-1111-4111-8111-111111111111'))).resolves.toBe('applied');

    const executionBinding = await manager.prepare(desired('').agentRef);
    await expect(manager.project(desired('22222222-2222-4222-8222-222222222222')))
      .rejects.toBeInstanceOf(AgentHomeBusyError);
    await executionBinding.lease.release();

    await expect(manager.project(desired('22222222-2222-4222-8222-222222222222')))
      .resolves.toBe('idempotent');
  });
});
