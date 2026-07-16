import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('blob client (protocol §7)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  async function setupDaemon(adapter: StubRuntimeAdapter): Promise<Daemon> {
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
    );
    await daemon.pair('code');
    await daemon.start();
    return daemon;
  }

  it('resolves an instruction blobRef via GET /byok/blobs/:id/url + fetch, instead of failing closed', async () => {
    const bigInstruction = 'do the big thing: '.repeat(1000); // large enough to plausibly need a blob
    server.seedBlob('instr-blob-1', bigInstruction, 'text/plain');

    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        {
          instruction: {
            blobRef: { blobId: 'instr-blob-1', contentHash: 'sha256:whatever', size: bigInstruction.length, contentType: 'text/plain' },
          },
          policy: { mode: 'auto' },
        },
        { taskId: 'task-blob-instr', seq: server.nextSeq() },
      ),
    );

    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.startCalls).toHaveLength(1));
    expect(adapter.startCalls[0]?.task.instruction).toBe(bigInstruction);
  });

  it('fails the task (not a pre-claim decline) if the referenced blob cannot be resolved', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope(
        'task.offer',
        {
          instruction: {
            blobRef: { blobId: 'no-such-blob', contentHash: 'sha256:x', size: 1, contentType: 'text/plain' },
          },
          policy: { mode: 'auto' },
        },
        { taskId: 'task-blob-missing', seq: server.nextSeq() },
      ),
    );

    // The runtime/policy checks already passed (this is a legitimate,
    // available device) — claiming happens before the blob is even fetched,
    // so a resolution failure is a post-claim task.fail, not a decline.
    await server.waitFor((e) => e.type === 'task.claim' && e.task_id === 'task-blob-missing');
    const fail = await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 'task-blob-missing');
    expect(fail.payload).toMatchObject({ retryable: true });
    expect(adapter.startCalls).toHaveLength(0);
  });

  it('sends a small artifact inline (base64), without ever calling POST /byok/blobs', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-artifact-small', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    const workspaceDir = adapter.startCalls[0]!.ctx.workspaceDir;

    const smallContent = 'hello artifact';
    await fs.writeFile(path.join(workspaceDir, 'small.txt'), smallContent, 'utf8');
    session.emit({ type: 'artifact', name: 'small.txt', contentType: 'text/plain' });
    session.emit({ type: 'turn_end' });

    const artifact = await server.waitFor((e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-small');
    const payload = artifact.payload as { name: string; contentType: string; inline?: string; blobRef?: unknown };
    expect(payload.blobRef).toBeUndefined();
    expect(payload.inline).toBe(Buffer.from(smallContent, 'utf8').toString('base64'));
    expect(server.httpRequests.some((r) => r.pathname === '/byok/blobs')).toBe(false);
  });

  it('uploads an artifact >64KB via POST /byok/blobs + PUT, and reports task.artifact with a sha-256 blobRef', async () => {
    const adapter = new StubRuntimeAdapter();
    await setupDaemon(adapter);

    server.send(
      createEnvelope('task.offer', { instruction: 'x', policy: { mode: 'auto' } }, { taskId: 'task-artifact-big', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const session = adapter.sessions[0]!;
    const workspaceDir = adapter.startCalls[0]!.ctx.workspaceDir;

    const bigContent = Buffer.from('x'.repeat(64 * 1024 + 100), 'utf8'); // just over the 64KB inline limit
    const expectedHash = `sha256:${createHash('sha256').update(bigContent).digest('hex')}`;
    await fs.writeFile(path.join(workspaceDir, 'big.bin'), bigContent);
    session.emit({ type: 'artifact', name: 'big.bin', contentType: 'application/octet-stream' });
    session.emit({ type: 'turn_end' });

    const artifact = await server.waitFor((e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-big');
    const payload = artifact.payload as {
      name: string;
      contentType: string;
      inline?: string;
      blobRef?: { blobId: string; contentHash: string; size: number; contentType: string };
    };
    expect(payload.inline).toBeUndefined();
    expect(payload.blobRef).toBeDefined();
    expect(payload.blobRef?.contentHash).toBe(expectedHash);
    expect(payload.blobRef?.size).toBe(bigContent.length);

    // The full round trip actually happened, not just a well-formed payload.
    expect(server.httpRequests.some((r) => r.method === 'POST' && r.pathname === '/byok/blobs')).toBe(true);
    const uploaded = server.blobContent(payload.blobRef!.blobId);
    expect(uploaded).toBeDefined();
    expect(uploaded?.equals(bigContent)).toBe(true);
  });
});
