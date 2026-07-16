import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok/protocol';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import type { Session, TaskContext } from '../types';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

function fakePiAdapter(): PiAdapter {
  return new PiAdapter({ resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }) });
}

async function takeEvents(session: Session, count: number): Promise<AgentEvent[]> {
  const results: AgentEvent[] = [];
  for await (const event of session.events) {
    results.push(event);
    if (results.length >= count) break;
  }
  return results;
}

async function makeCtx(env: NodeJS.ProcessEnv = process.env): Promise<TaskContext> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-adapter-test-'));
  return { workspaceDir, policy: { mode: 'auto' }, env };
}

const baseTask: TaskOfferPayload = {
  instruction: 'say hi',
  policy: { mode: 'auto' },
};

describe('PiAdapter against the fake-pi fixture', () => {
  const openSessions: Session[] = [];

  afterEach(async () => {
    await Promise.all(openSessions.splice(0).map((s) => s.close()));
  });

  it('detect() reports present + version from the fake binary', async () => {
    const adapter = fakePiAdapter();
    const result = await adapter.detect();
    expect(result.present).toBe(true);
    expect(result.version).toBe('0.0.0-fake');
  });

  it('start() drives the canned prompt sequence into normalized AgentEvents', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    expect(typeof session.sessionRef).toBe('string');
    expect(session.sessionRef.length).toBeGreaterThan(0);

    const events = await takeEvents(session, 5);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' } },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] }, isError: false },
      },
      { type: 'progress', text: 'Hello ' },
      { type: 'progress', text: 'world' },
      { type: 'turn_end' },
    ]);
  });

  it('FAKE_PI_ARTIFACT_NAME drives a >64KB file write + an artifact AgentEvent (M1-4 blob-path e2e fixture)', async () => {
    const adapter = fakePiAdapter();
    const artifactName = 'big-artifact.bin';
    const size = 70000; // > the 64KB inline-artifact limit
    const ctx = await makeCtx({
      ...process.env,
      FAKE_PI_ARTIFACT_NAME: artifactName,
      FAKE_PI_ARTIFACT_SIZE: String(size),
    });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 7);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' } },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] }, isError: false },
      },
      { type: 'tool_use', tool: 'write', input: { path: artifactName, content: `<${size} bytes written by fake-pi>` } },
      {
        type: 'tool_result',
        tool: 'write',
        output: { result: { content: [{ type: 'text', text: `Successfully wrote ${size} bytes to ${artifactName}` }] }, isError: false },
      },
      { type: 'artifact', name: artifactName, contentType: 'application/octet-stream' },
      { type: 'progress', text: 'Hello ' },
      { type: 'progress', text: 'world' },
    ]);

    const written = await fs.readFile(path.join(ctx.workspaceDir, artifactName));
    expect(written.length).toBe(size);
  });

  it('FAKE_PI_HANG_AFTER_TOOL keeps the session Running past the tool call; interrupt()+close() still tear it down cleanly (M1-4 cancel-path e2e fixture)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_HANG_AFTER_TOOL: '1' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    const events = await takeEvents(session, 2);
    expect(events).toEqual([
      { type: 'tool_use', tool: 'bash', input: { command: 'echo hi' } },
      {
        type: 'tool_result',
        tool: 'bash',
        output: { result: { content: [{ type: 'text', text: 'hi\n' }] }, isError: false },
      },
    ]);

    // No turn_end ever arrives on its own — the daemon's cancel path doesn't
    // wait on it; interrupt() (best-effort) + close() (SIGTERM) must still
    // resolve cleanly, exactly as `TaskRunner.handleCancel`/`finish` rely on.
    await expect(session.interrupt()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('start() with no sessionRef resolves pi\'s real minted session id via get_state (not a locally-generated UUID)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_SESSION_ID: 'fixture-minted-session-xyz' });
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);
    expect(session.sessionRef).toBe('fixture-minted-session-xyz');
  });

  it('a task.offer carrying a known sessionRef resumes it via the real `--session <id>` flag', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_SESSION_ID: 'resume-me-123' });
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'resume-me-123' };
    const session = await adapter.start(task, ctx);
    openSessions.push(session);
    expect(session.sessionRef).toBe('resume-me-123');
  });

  it('an unresolvable sessionRef surfaces pi\'s real resume rejection as a clean start() failure, not a hang (empirically confirmed against real pi: "No session found matching ...", exit 1)', async () => {
    const adapter = fakePiAdapter();
    // FAKE_PI_SESSION_ID defaults to 'fake-session-1' — this ref never matches it.
    const ctx = await makeCtx();
    const task: TaskOfferPayload = { ...baseTask, sessionRef: 'some-other-unknown-id' };
    await expect(adapter.start(task, ctx)).rejects.toThrow(/No session found matching/);
  });

  it('interrupt() sends abort and the fake pi settles afterward', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    const session = await adapter.start(baseTask, ctx);
    openSessions.push(session);

    await takeEvents(session, 5); // drain the initial prompt's events first
    await expect(session.interrupt()).resolves.toBeUndefined();

    const postAbort = await takeEvents(session, 1);
    expect(postAbort).toEqual([{ type: 'turn_end' }]);
  });

  it('surfaces a missing-API-key rejection from the initial prompt as a clean start() failure', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx({ ...process.env, FAKE_PI_NO_KEY: '1' });
    await expect(adapter.start(baseTask, ctx)).rejects.toThrow(/No API key found/);
  });

  it('fails closed on a policy pi cannot express, without ever spawning a process', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    ctx.policy = { mode: 'confirm' };
    await expect(adapter.start(baseTask, ctx)).rejects.toThrow(/cannot express permission mode "confirm"/);
  });

  it('fails closed on a blob-ref instruction (no blob fetch in M0)', async () => {
    const adapter = fakePiAdapter();
    const ctx = await makeCtx();
    const task: TaskOfferPayload = {
      ...baseTask,
      instruction: { blobRef: { blobId: 'b1', contentHash: 'sha256:x', size: 10, contentType: 'text/plain' } },
    };
    await expect(adapter.start(task, ctx)).rejects.toThrow(/only supports string instructions/);
  });

  it('capabilities() advertises exactly what the adapter can express', () => {
    const adapter = fakePiAdapter();
    expect(adapter.capabilities()).toEqual({ steer: true, resume: true, permissionModes: ['auto', 'readonly'] });
  });
});

describe('PiAdapter against the real installed optionalDependency (no network/API key required)', () => {
  it('detect() returns a well-formed result whether or not pi is actually installed here', async () => {
    const adapter = new PiAdapter();
    const result = await adapter.detect();
    expect(typeof result.present).toBe('boolean');
    if (result.present) {
      expect(typeof result.version).toBe('string');
      expect(result.version?.length).toBeGreaterThan(0);
    }
  });
});
