import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, RESULT_DOCUMENT_MAX_BYTES, type Envelope } from '@byok-sdk/protocol';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import {
  RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX,
  TaskRunner,
  type ResultDocumentTask,
  type TaskRunnerDeps,
} from '../daemon/task-runner';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * additive-minor (`task.complete.document`): the daemon-side seam between a
 * host-configured `resultDocument.extract` and the wire —
 * `TaskRunner.resolveResultDocument`'s cap gate, capability gate, and three
 * fail-closed branches, driven directly (no control socket, no real
 * connection) the same way `task-runner-resource-limits.test.ts` drives the
 * other local enforcement paths.
 *
 * The last describe block closes the loop through a real daemon and the
 * in-process `TestServer`, which is what actually proves `DaemonConfig
 * .resultDocument` reaches `TaskRunnerDeps` and that the capability read is
 * the negotiated `conn.ack.capabilities`, not a value a test handed in.
 */

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

async function makeRunner(
  adapter: StubRuntimeAdapter,
  sent: Envelope[],
  overrides: Partial<Pick<TaskRunnerDeps, 'resultDocument' | 'getServerCapabilities'>> = {},
): Promise<TaskRunner> {
  const deps: TaskRunnerDeps = {
    adapters: [adapter],
    workspaceRoot: await tmpDir('byok-result-document-workspace-'),
    deviceId: 'device-1',
    send: (envelope) => {
      sent.push(envelope);
    },
    blobClient: unusedBlobClient,
    sessionWorkspaces: new SessionWorkspaceStore(await tmpDir('byok-result-document-store-')),
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    getServerCapabilities: overrides.getServerCapabilities,
    ...(overrides.resultDocument ? { resultDocument: overrides.resultDocument } : {}),
  };
  return new TaskRunner(deps);
}

async function runToTurnEnd(
  runner: TaskRunner,
  adapter: StubRuntimeAdapter,
  taskId: string,
  outputChunks: string[] = ['all ', 'done'],
): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { instruction: 'do the thing', policy: { mode: 'auto' } }, { taskId, seq: 1 }),
  );
  const session = adapter.sessions[0]!;
  for (const text of outputChunks) session.emit({ type: 'progress', text });
  session.emit({ type: 'turn_end' });
}

function terminal(sent: Envelope[]): Envelope | undefined {
  return sent.find((e) => e.type === 'task.complete' || e.type === 'task.fail' || e.type === 'task.cancelled');
}

async function waitForTerminal(sent: Envelope[]): Promise<Envelope> {
  await vi.waitFor(() => expect(terminal(sent)).toBeDefined());
  return terminal(sent)!;
}

/**
 * The FULL fail-closed contract every rejection branch must satisfy, asserted
 * in one place so no branch can drift into checking less than its siblings
 * (gatekeeper addendum): `task.fail` with the stable prefix and the branch's
 * own detail, `retryable: false`, NO `task.complete` at all, and no envelope
 * anywhere carrying a `document`.
 */
function expectFailClosed(sent: Envelope[], outcome: Envelope, detail: string): void {
  expect(outcome.type).toBe('task.fail');
  if (outcome.type !== 'task.fail') throw new Error('unreachable');
  expect(outcome.payload.retryable).toBe(false);
  expect(outcome.payload.reason.startsWith(RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX)).toBe(true);
  expect(outcome.payload.reason).toContain(detail);
  expect(sent.some((e) => e.type === 'task.complete')).toBe(false);
  expect(sent.some((e) => JSON.stringify(e).includes('"document"'))).toBe(false);
}

const CAPABLE = () => ['steer', 'result-document'];
const NOT_CAPABLE = () => ['steer', 'approval_resolved'];

describe('TaskRunner: result document, flag-gated send', () => {
  it('sends the extracted document on task.complete when the server advertised result-document', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      resultDocument: { extract: () => ({ kind: 'invoice', total: 42 }) },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    const done = await waitForTerminal(sent);
    expect(done.type).toBe('task.complete');
    if (done.type !== 'task.complete') throw new Error('unreachable');
    expect(done.payload.document).toEqual({ kind: 'invoice', total: 42 });
    // The pre-existing fields are untouched by the addition.
    expect(done.payload.summary).toBe('all done');
    expect(done.payload.sessionRef).toBe(adapter.sessions[0]!.sessionRef);
  });

  it('passes the final output text and the task identity to the extractor', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const calls: Array<{ finalOutput: string; task: ResultDocumentTask }> = [];
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      resultDocument: {
        extract: (finalOutput, task) => {
          calls.push({ finalOutput, task });
          return { ok: true };
        },
      },
    });

    await runToTurnEnd(runner, adapter, 'task-1', ['part one, ', 'part two']);
    await waitForTerminal(sent);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.finalOutput).toBe('part one, part two');
    expect(calls[0]!.task).toEqual({ taskId: 'task-1', sessionRef: adapter.sessions[0]!.sessionRef });
  });

  it('sends NO document when the extractor returns undefined — completion is identical to having no extractor at all', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      resultDocument: { extract: () => undefined },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    const done = await waitForTerminal(sent);
    expect(done.type).toBe('task.complete');
    expect('document' in done.payload).toBe(false);
  });

  it('never consults the capability list when the extractor produced nothing (no document, nothing to gate)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const getServerCapabilities = vi.fn(NOT_CAPABLE);
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities,
      resultDocument: { extract: () => undefined },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    const done = await waitForTerminal(sent);
    expect(done.type).toBe('task.complete');
    expect(getServerCapabilities).not.toHaveBeenCalled();
  });
});

describe('TaskRunner: result document, fail-closed branches', () => {
  it('fails the task (retryable:false) when the document is over the cap — and never truncates it', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const framing = JSON.stringify({ a: '' }).length;
    const overCap = { a: 'x'.repeat(RESULT_DOCUMENT_MAX_BYTES + 1 - framing) };
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      resultDocument: { extract: () => overCap },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    const outcome = await waitForTerminal(sent);
    // The reason names the measured size and the limit — an operator can act
    // on it without reproducing the task.
    expectFailClosed(sent, outcome, String(RESULT_DOCUMENT_MAX_BYTES + 1));
    if (outcome.type !== 'task.fail') throw new Error('unreachable');
    expect(outcome.payload.reason).toContain(String(RESULT_DOCUMENT_MAX_BYTES));
  });

  it('accepts a document sitting EXACTLY on the cap (the boundary is inclusive, and the daemon agrees with the wire)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const framing = JSON.stringify({ a: '' }).length;
    const atCap = { a: 'x'.repeat(RESULT_DOCUMENT_MAX_BYTES - framing) };
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      resultDocument: { extract: () => atCap },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    const done = await waitForTerminal(sent);
    expect(done.type).toBe('task.complete');
    if (done.type !== 'task.complete') throw new Error('unreachable');
    expect(done.payload.document).toEqual(atCap);
  });

  it('fails the task (retryable:false) when the document is not JSON-serializable', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      resultDocument: { extract: () => circular },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    expectFailClosed(sent, await waitForTerminal(sent), 'not JSON-serializable');
  });

  it('fails the task (retryable:false) when the document is not plain JSON data — it would be silently transformed on the way out (F1/F2)', async () => {
    // Every one of these JSON.stringify-es "successfully" into something the
    // producer never had: a dropped key, `null` for NaN, a string for a Date,
    // and (the contextual-toJSON smuggler) a different value entirely
    // depending on the key it is serialized under.
    const cases: Record<string, unknown> = {
      'undefined-valued key / NaN / hole in an array': { required: undefined, n: NaN, arr: [undefined] },
      'Date instance': { at: new Date('2026-01-01T00:00:00.000Z') },
      'contextual toJSON(key)': { toJSON: (key: string) => (key === '' ? { tiny: true } : { a: 'x'.repeat(RESULT_DOCUMENT_MAX_BYTES * 2) }) },
    };

    for (const [label, document] of Object.entries(cases)) {
      const perCaseSent: Envelope[] = [];
      const perCaseAdapter = new StubRuntimeAdapter();
      const runner = await makeRunner(perCaseAdapter, perCaseSent, {
        getServerCapabilities: CAPABLE,
        resultDocument: { extract: () => document },
      });

      await runToTurnEnd(runner, perCaseAdapter, `task-${label.length}`);

      expectFailClosed(perCaseSent, await waitForTerminal(perCaseSent), 'not plain JSON data');
    }
  });

  it('sends the CANONICAL SNAPSHOT, not the extractor\'s object — a stable getter is neutralized into pure data', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      resultDocument: {
        extract: () => ({
          get answer(): number {
            return 42;
          },
          plain: 'data',
        }),
      },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    const done = await waitForTerminal(sent);
    expect(done.type).toBe('task.complete');
    if (done.type !== 'task.complete') throw new Error('unreachable');
    expect(done.payload.document).toEqual({ answer: 42, plain: 'data' });
    // What is on the wire is pure data — no accessor survived the snapshot,
    // so the bytes measured by the cap gate are necessarily the bytes sent.
    expect(Object.getOwnPropertyDescriptor(done.payload.document as object, 'answer')?.get).toBeUndefined();
  });

  it('fails the task (retryable:false) when the extractor throws — the error is surfaced, not swallowed', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      resultDocument: {
        extract: () => {
          throw new Error('no JSON block in the model output');
        },
      },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    expectFailClosed(sent, await waitForTerminal(sent), 'no JSON block in the model output');
  });

  it('fails the task (retryable:false) when the extractor is async — a promise would encode to an empty document, a confidently wrong result', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: CAPABLE,
      // Typed as returning `unknown`, so an async function is type-legal —
      // which is exactly why the runtime has to catch it.
      resultDocument: { extract: async () => ({ kind: 'invoice' }) },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    // The outcome this branch exists to prevent: a completion carrying `{}`
    // as though it were the product's real structured result.
    expectFailClosed(sent, await waitForTerminal(sent), 'returned a promise; the contract is synchronous');
  });

  it('fails the task (retryable:false) when the capability DISAPPEARS between the gate and the send — a reconnect to an older server mid-completion (F3)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    // Capable when `resolveResultDocument` asks, gone by the time the
    // envelope is actually handed to `send` — exactly what a reconnect does
    // (`ConnectionManager.onWsOutcome` clears the learned capabilities on an
    // acked-then-closed connection). Without the post-await re-check, the
    // completion would be queued carrying a document for a server that
    // strips it.
    let reads = 0;
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: () => {
        reads += 1;
        return reads === 1 ? ['result-document'] : [];
      },
      resultDocument: { extract: () => ({ kind: 'invoice' }) },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    expectFailClosed(sent, await waitForTerminal(sent), 'stopped advertising the result-document capability');
    // Both the gate and the pre-send re-check ran — the second is what
    // caught it.
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('fails the task (retryable:false) when a document exists but the server never advertised result-document — it is never silently omitted', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, {
      getServerCapabilities: NOT_CAPABLE,
      resultDocument: { extract: () => ({ kind: 'invoice' }) },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    // The forbidden outcome this whole gate exists to prevent: a completion
    // that quietly dropped the task's structured result.
    expectFailClosed(sent, await waitForTerminal(sent), 'result-document capability');
  });

  it('treats an absent capability list the same as one without the flag (fail-closed, not fail-open)', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent, {
      // getServerCapabilities omitted entirely — a harness or a daemon that
      // has not completed a handshake knows of no capability at all.
      resultDocument: { extract: () => ({ kind: 'invoice' }) },
    });

    await runToTurnEnd(runner, adapter, 'task-1');

    expectFailClosed(sent, await waitForTerminal(sent), 'result-document capability');
  });
});

describe('TaskRunner: no extractor configured', () => {
  it('completes byte-identically to the pre-change payload, consulting neither extractor nor capabilities', async () => {
    const adapter = new StubRuntimeAdapter();
    const sent: Envelope[] = [];
    const getServerCapabilities = vi.fn(CAPABLE);
    const runner = await makeRunner(adapter, sent, { getServerCapabilities });

    await runToTurnEnd(runner, adapter, 'task-1');

    const done = await waitForTerminal(sent);
    expect(done.type).toBe('task.complete');
    if (done.type !== 'task.complete') throw new Error('unreachable');
    expect(done.payload).toEqual({ summary: 'all done', sessionRef: adapter.sessions[0]!.sessionRef });
    expect('document' in done.payload).toBe(false);
    expect(getServerCapabilities).not.toHaveBeenCalled();
  });
});

describe('DaemonConfig.resultDocument end to end (real daemon + in-process server)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
    daemon = undefined;
  });

  async function setupDaemon(
    adapter: StubRuntimeAdapter,
    configOverrides: Partial<Parameters<typeof createDaemonWithAdapters>[0]> = {},
  ): Promise<Daemon> {
    daemon = createDaemonWithAdapters(
      {
        productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot: await tmpDir('byok-result-document-e2e-workspace-'),
        storeDir: await tmpDir('byok-result-document-e2e-store-'),
        ...configOverrides,
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();
    return daemon;
  }

  async function driveOneTask(adapter: StubRuntimeAdapter): Promise<Envelope> {
    server.send(
      createEnvelope('task.offer', { instruction: 'do the thing', policy: { mode: 'auto' } }, { taskId: 'task-1', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'all done' });
    session.emit({ type: 'turn_end' });
    return server.waitFor((e) => e.type === 'task.complete' || e.type === 'task.fail');
  }

  it('carries the configured extractor through DaemonConfig to the wire when the negotiated conn.ack advertises result-document', async () => {
    server.setAckCapabilities(['result-document']);
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter, { resultDocument: { extract: (finalOutput) => ({ echoed: finalOutput }) } });

    const terminalEnvelope = await driveOneTask(adapter);
    expect(terminalEnvelope.type).toBe('task.complete');
    if (terminalEnvelope.type !== 'task.complete') throw new Error('unreachable');
    expect(terminalEnvelope.payload.document).toEqual({ echoed: 'all done' });
  });

  it('fails the task against a server whose real handshake advertised no result-document', async () => {
    server.setAckCapabilities([]);
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter, { resultDocument: { extract: () => ({ kind: 'invoice' }) } });

    const terminalEnvelope = await driveOneTask(adapter);
    expect(terminalEnvelope.type).toBe('task.fail');
    if (terminalEnvelope.type !== 'task.fail') throw new Error('unreachable');
    expect(terminalEnvelope.payload.retryable).toBe(false);
    expect(terminalEnvelope.payload.reason.startsWith(RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX)).toBe(true);
  });

  it('completes normally with no resultDocument configured, even against a result-document-capable server', async () => {
    server.setAckCapabilities(['result-document']);
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    const terminalEnvelope = await driveOneTask(adapter);
    expect(terminalEnvelope.type).toBe('task.complete');
    if (terminalEnvelope.type !== 'task.complete') throw new Error('unreachable');
    expect('document' in terminalEnvelope.payload).toBe(false);
  });

  it('fails the task when the server ROLLS BACK mid-task — capable at claim, not capable at completion (F3, real reconnect)', async () => {
    // Capable when the task starts...
    server.setAckCapabilities(['result-document']);
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter, { resultDocument: { extract: () => ({ kind: 'invoice' }) } });

    server.send(
      createEnvelope('task.offer', { instruction: 'do the thing', policy: { mode: 'auto' } }, { taskId: 'task-1', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');

    // ...and rolled back to an older build before the task finishes. A real
    // reconnect is what makes this observable: the daemon drops its learned
    // capabilities the moment the acked connection closes, and the new
    // handshake teaches it the older server's (empty) set.
    const countHellos = (): number => server.received.filter((e) => e.type === 'conn.hello').length;
    expect(countHellos()).toBe(1);
    server.setAckCapabilities([]);
    server.dropConnection();
    await vi.waitFor(() => expect(countHellos()).toBe(2), { timeout: 5000 });

    const session = adapter.sessions[0]!;
    session.emit({ type: 'progress', text: 'all done' });
    session.emit({ type: 'turn_end' });

    const terminalEnvelope = await server.waitFor((e) => e.type === 'task.complete' || e.type === 'task.fail');
    expect(terminalEnvelope.type).toBe('task.fail');
    if (terminalEnvelope.type !== 'task.fail') throw new Error('unreachable');
    expect(terminalEnvelope.payload.retryable).toBe(false);
    expect(terminalEnvelope.payload.reason.startsWith(RESULT_DOCUMENT_UNDELIVERABLE_REASON_PREFIX)).toBe(true);
    // The document never reached the rolled-back server in any frame.
    expect(server.received.some((e) => JSON.stringify(e).includes('"document"'))).toBe(false);
  });
});
