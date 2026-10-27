import { testScratchOwner } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { AGENT_HOME_DIRECTORY, AgentHomeManager } from '../agent-home';
import { GrokAdapter } from '../adapters/grok/grok-adapter';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { TaskRunner } from '../daemon/task-runner';
import { testIngressBudget } from './fixtures/activity-ingress';
import { FRESH_OFFER, freshOfferEgressDeps } from './fixtures/fresh-offer';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

// #609: memory-reader Attempts through the real TaskRunner, Agent home and Grok adapter.
const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function temporary(prefix: string): Promise<string> {
  const value = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(value);
  return value;
}

async function harness() {
  const log = path.join(await temporary('byok-grok-reader-log-'), 'agent.log');
  vi.stubEnv('FAKE_ACP_LOG', log);
  const sent: Envelope[] = [];
  const storeDir = await temporary('byok-grok-reader-store-');
  const hostStorageRoot = await temporary('byok-grok-reader-home-');
  const runner = new TaskRunner({ advertisedCapabilities: advertiseEveryDeviceFlag, ...freshOfferEgressDeps(), getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
    adapters: [new GrokAdapter({ resolveBin: () => ({ command: fixture, source: 'path' }) })],
    getServerCapabilities: () => ['custom-harness'],
    agentHome: new AgentHomeManager({ hostStorageRoot }),
    agentSessionHandoffs: new AgentSessionHandoffStore(), deviceId: 'device-grok-reader',
    send: (envelope) => sent.push(envelope),
    blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
    approvalRegistry: new ApprovalRegistry(),
    storeDir, productId: 'grok-reader-test', tenantId: 'tenant-grok-reader',
  });
  let seq = 0;
  return {
    sent,
    home: async (agentId: string, persona?: string) => {
      const home = path.join(hostStorageRoot, AGENT_HOME_DIRECTORY, agentId);
      await fs.mkdir(home, { recursive: true });
      if (persona !== undefined) await fs.writeFile(path.join(home, 'AGENTS.md'), persona);
      return home;
    },
    offerReader: (taskId: string, agentId: string, sessionRef?: string) => runner.handleEnvelope(createEnvelope('task.offer', {
      instruction: 'hello', harnessId: 'grok', agentRef: { agentId, profileRevision: 'r1' }, homeAccess: 'memory-reader' as const,
      ...(sessionRef === undefined ? FRESH_OFFER : { session: { mode: 'resume' as const, sessionRef } }),
    }, { taskId, seq: ++seq })),
    terminal: async (taskId: string) => {
      await vi.waitFor(() => expect(sent.some((envelope) => envelope.task_id === taskId
        && ['task.complete', 'task.fail', 'task.decline'].includes(envelope.type))).toBe(true), { timeout: 8000 });
      return sent.find((envelope) => envelope.task_id === taskId && ['task.complete', 'task.fail', 'task.decline'].includes(envelope.type))!;
    },
    opened: async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(fact => fact.kind === 'open'),
    started: async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(fact => fact.kind === 'start'),
  };
}

it('gives a fresh memory-reader Attempt the canonical home persona in its run directory', async () => {
  const h = await harness();
  const home = await h.home('reader-persona', 'Begin with SYNTHETIC_READER_PERSONA');
  await h.offerReader('fresh-reader', 'reader-persona');
  expect((await h.terminal('fresh-reader')).type).toBe('task.complete');
  const [opened] = await h.opened();
  expect(opened.method).toBe('session/new');
  expect(opened.params.cwd).toBe(path.join(home, '.byok', 'runs', 'fresh-reader'));
  expect(opened.params._meta).toEqual({ yoloMode: true, rules: 'Begin with SYNTHETIC_READER_PERSONA' });
});

it('resumes a memory-reader session without a persona in the run directory its handoff recorded', async () => {
  const h = await harness();
  const home = await h.home('reader-plain');
  await h.offerReader('first-reader', 'reader-plain');
  expect((await h.terminal('first-reader')).type).toBe('task.complete');
  await h.offerReader('resumed-reader', 'reader-plain', 'fake-grok-session');
  expect(await h.terminal('resumed-reader')).toMatchObject({ type: 'task.complete' });
  const resumed = (await h.opened())[1];
  expect(resumed.method).toBe('session/resume');
  expect(resumed.params.cwd).toBe(path.join(home, '.byok', 'runs', 'first-reader'));
  expect(resumed.params._meta).toEqual({ yoloMode: true });
});

it('refuses a persona-bearing memory-reader resume as unqualified, without opening a session', async () => {
  const h = await harness();
  await h.home('reader-resume-persona', 'persona');
  await h.offerReader('first-persona-reader', 'reader-resume-persona');
  expect((await h.terminal('first-persona-reader')).type).toBe('task.complete');
  await h.offerReader('resumed-persona-reader', 'reader-resume-persona', 'fake-grok-session');
  const refused = await h.terminal('resumed-persona-reader');
  expect(refused).toMatchObject({ type: 'task.fail', payload: { retryable: false } });
  expect(String((refused.payload as { reason?: unknown }).reason)).toContain('persona resume is not qualified');
  expect(await h.opened()).toHaveLength(1);
  // Refused before spawning: only the first Attempt started an agent process.
  expect(await h.started()).toHaveLength(1);
});
