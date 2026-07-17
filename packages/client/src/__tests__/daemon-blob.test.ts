import { createHash } from 'node:crypto';
import { promises as fs, symlinkSync, unlinkSync } from 'node:fs';
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
            blobRef: {
              blobId: 'instr-blob-1',
              contentHash: `sha256:${'a1'.repeat(32)}`, // finding F9: must be 64 lowercase hex chars
              size: bigInstruction.length,
              contentType: 'text/plain',
            },
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
            blobRef: {
              blobId: 'no-such-blob',
              contentHash: `sha256:${'b2'.repeat(32)}`, // finding F9: must be 64 lowercase hex chars
              size: 1,
              contentType: 'text/plain',
            },
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

  /** Finding F7/N5: artifact path traversal, TOCTOU symlink race, + swallowed failures. */
  describe('artifact path safety and failure visibility (finding F7/N5)', () => {
    it('rejects a "../../etc"-style traversal name — never reads or sends the escaped file, and surfaces a loud error event', async () => {
      const adapter = new StubRuntimeAdapter();
      await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto' } },
          { taskId: 'task-artifact-traversal', seq: server.nextSeq() },
        ),
      );
      await server.waitFor((e) => e.type === 'task.started');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      const session = adapter.sessions[0]!;

      // Deep enough to escape the workspace regardless of its nesting depth
      // under the OS tmp dir; /etc/hosts is a real, readable file on every
      // POSIX test runner this suite targets — a convincing, concrete
      // exfiltration target rather than a path that merely doesn't exist.
      const traversalName = '../../../../../../../../../../etc/hosts';
      session.emit({ type: 'artifact', name: traversalName, contentType: 'text/plain' });
      session.emit({ type: 'turn_end' });

      await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-artifact-traversal');

      expect(server.received.some((e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-traversal')).toBe(
        false,
      );
      expect(server.httpRequests.some((r) => r.pathname === '/byok/blobs')).toBe(false);

      const progressWithError = server.received.find(
        (e) =>
          e.type === 'task.progress' &&
          e.task_id === 'task-artifact-traversal' &&
          (e.payload as { events: Array<{ type: string; message?: string }> }).events.some(
            (ev) => ev.type === 'error' && ev.message?.includes(traversalName),
          ),
      );
      expect(progressWithError).toBeDefined();
    });

    it('rejects an absolute artifact name — path.resolve would otherwise let it override the workspace base entirely', async () => {
      const adapter = new StubRuntimeAdapter();
      await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto' } },
          { taskId: 'task-artifact-absolute', seq: server.nextSeq() },
        ),
      );
      await server.waitFor((e) => e.type === 'task.started');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      const session = adapter.sessions[0]!;

      // A real, readable file — same rationale as the traversal test above:
      // a convincing exfiltration target, not merely a nonexistent path.
      const absoluteName = '/etc/hosts';
      session.emit({ type: 'artifact', name: absoluteName, contentType: 'text/plain' });
      session.emit({ type: 'turn_end' });

      await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-artifact-absolute');

      expect(server.received.some((e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-absolute')).toBe(
        false,
      );
      expect(server.httpRequests.some((r) => r.pathname === '/byok/blobs')).toBe(false);

      const progressWithError = server.received.find(
        (e) =>
          e.type === 'task.progress' &&
          e.task_id === 'task-artifact-absolute' &&
          (e.payload as { events: Array<{ type: string; message?: string }> }).events.some(
            (ev) => ev.type === 'error' && ev.message?.includes(absoluteName),
          ),
      );
      expect(progressWithError).toBeDefined();
    });

    it('surfaces a failed artifact upload as a loud error event instead of swallowing it — the task still completes', async () => {
      const adapter = new StubRuntimeAdapter();
      await setupDaemon(adapter);
      server.setFailBlobUploads(true);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto' } },
          { taskId: 'task-artifact-upload-fail', seq: server.nextSeq() },
        ),
      );
      await server.waitFor((e) => e.type === 'task.started');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      const session = adapter.sessions[0]!;
      const workspaceDir = adapter.startCalls[0]!.ctx.workspaceDir;

      const bigContent = Buffer.from('y'.repeat(64 * 1024 + 100), 'utf8'); // forces the blob-upload path
      await fs.writeFile(path.join(workspaceDir, 'big-fail.bin'), bigContent);
      session.emit({ type: 'artifact', name: 'big-fail.bin', contentType: 'application/octet-stream' });
      session.emit({ type: 'turn_end' });

      // Task still reaches Complete — an artifact failure doesn't fail the task.
      const complete = await server.waitFor(
        (e) => e.type === 'task.complete' && e.task_id === 'task-artifact-upload-fail',
      );
      expect(complete).toBeDefined();

      expect(
        server.received.some((e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-upload-fail'),
      ).toBe(false);

      const progressWithError = server.received.find(
        (e) =>
          e.type === 'task.progress' &&
          e.task_id === 'task-artifact-upload-fail' &&
          (e.payload as { events: Array<{ type: string; message?: string }> }).events.some(
            (ev) => ev.type === 'error' && ev.message?.includes('big-fail.bin'),
          ),
      );
      expect(progressWithError).toBeDefined();
    });

    it('still uploads a normal in-workspace regular-file artifact correctly (blobRef + sha-256 contentHash) — the open-then-verify fix does not regress the happy path', async () => {
      const adapter = new StubRuntimeAdapter();
      await setupDaemon(adapter);

      server.send(
        createEnvelope(
          'task.offer',
          { instruction: 'x', policy: { mode: 'auto' } },
          { taskId: 'task-artifact-regular-ok', seq: server.nextSeq() },
        ),
      );
      await server.waitFor((e) => e.type === 'task.started');
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
      const session = adapter.sessions[0]!;
      const workspaceDir = adapter.startCalls[0]!.ctx.workspaceDir;

      // Force the blob-upload path (>64KB) so both `blobRef` and
      // `contentHash` are exercised, not just the inline path.
      const content = Buffer.from('ok-artifact-'.repeat(6000), 'utf8');
      const expectedHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      await fs.writeFile(path.join(workspaceDir, 'regular.bin'), content);
      session.emit({ type: 'artifact', name: 'regular.bin', contentType: 'application/octet-stream' });
      session.emit({ type: 'turn_end' });

      const artifact = await server.waitFor((e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-regular-ok');
      const payload = artifact.payload as {
        blobRef?: { blobId: string; contentHash: string; size: number };
      };
      expect(payload.blobRef).toBeDefined();
      expect(payload.blobRef?.contentHash).toBe(expectedHash);
      expect(payload.blobRef?.size).toBe(content.length);

      const uploaded = server.blobContent(payload.blobRef!.blobId);
      expect(uploaded?.equals(content)).toBe(true);
    });

    describe('TOCTOU symlink race (finding F7/N5) — open-then-verify-on-fd', () => {
      it('rejects an artifact name that is already a symlink pointing outside the workspace', async () => {
        const adapter = new StubRuntimeAdapter();
        await setupDaemon(adapter);

        server.send(
          createEnvelope(
            'task.offer',
            { instruction: 'x', policy: { mode: 'auto' } },
            { taskId: 'task-artifact-symlink-outside', seq: server.nextSeq() },
          ),
        );
        await server.waitFor((e) => e.type === 'task.started');
        await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
        const session = adapter.sessions[0]!;
        const workspaceDir = adapter.startCalls[0]!.ctx.workspaceDir;

        const linkName = 'evil-link.txt';
        await fs.symlink('/etc/hosts', path.join(workspaceDir, linkName));
        session.emit({ type: 'artifact', name: linkName, contentType: 'text/plain' });
        session.emit({ type: 'turn_end' });

        await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-artifact-symlink-outside');

        expect(
          server.received.some((e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-symlink-outside'),
        ).toBe(false);
        expect(server.httpRequests.some((r) => r.pathname === '/byok/blobs')).toBe(false);

        const progressWithError = server.received.find(
          (e) =>
            e.type === 'task.progress' &&
            e.task_id === 'task-artifact-symlink-outside' &&
            (e.payload as { events: Array<{ type: string; message?: string }> }).events.some(
              (ev) => ev.type === 'error' && ev.message?.includes(linkName),
            ),
        );
        expect(progressWithError).toBeDefined();
      });

      it('rejects an artifact name whose INTERMEDIATE directory component is a symlink pointing outside the workspace (finding P4/Codex) — a lexical containment check alone would wrongly pass this', async () => {
        const adapter = new StubRuntimeAdapter();
        await setupDaemon(adapter);

        server.send(
          createEnvelope(
            'task.offer',
            { instruction: 'x', policy: { mode: 'auto' } },
            { taskId: 'task-artifact-intermediate-symlink', seq: server.nextSeq() },
          ),
        );
        await server.waitFor((e) => e.type === 'task.started');
        await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
        const session = adapter.sessions[0]!;
        const workspaceDir = adapter.startCalls[0]!.ctx.workspaceDir;

        // A real, readable secret file in a directory the runtime should
        // never be able to reach.
        const outsideDir = await tmpDir('byok-outside-secret-');
        const secretPath = path.join(outsideDir, 'secret.txt');
        await fs.writeFile(secretPath, 'top secret, outside the workspace', 'utf8');

        // The INTERMEDIATE path component ("sublink") is a symlink to that
        // outside directory, created inside the workspace — exactly what a
        // runtime could do on its own. The FINAL component ("secret.txt"),
        // once the symlink is followed, is a perfectly ordinary regular
        // file — `O_NOFOLLOW` (which POSIX only applies to the final path
        // component) has nothing to reject here. Only a containment check
        // that resolves the WHOLE candidate path (not just the workspace
        // root) catches this — a purely lexical `path.resolve` +
        // string-prefix check would wrongly pass it, since
        // `<workspace>/sublink/secret.txt` lexically starts with
        // `<workspace>/` regardless of what `sublink` actually points at.
        await fs.symlink(outsideDir, path.join(workspaceDir, 'sublink'));
        const artifactName = 'sublink/secret.txt';

        session.emit({ type: 'artifact', name: artifactName, contentType: 'text/plain' });
        session.emit({ type: 'turn_end' });

        await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-artifact-intermediate-symlink');

        expect(
          server.received.some(
            (e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-intermediate-symlink',
          ),
        ).toBe(false);
        expect(server.httpRequests.some((r) => r.pathname === '/byok/blobs')).toBe(false);

        const progressWithError = server.received.find(
          (e) =>
            e.type === 'task.progress' &&
            e.task_id === 'task-artifact-intermediate-symlink' &&
            (e.payload as { events: Array<{ type: string; message?: string }> }).events.some(
              (ev) => ev.type === 'error' && ev.message?.includes(artifactName),
            ),
        );
        expect(progressWithError).toBeDefined();
      });

      it('rejects an artifact swapped from a regular file to an outside-pointing symlink inside openArtifact\'s own internal gap — the narrowest TOCTOU window the fix leaves, still closed by O_NOFOLLOW', async () => {
        const adapter = new StubRuntimeAdapter();
        await setupDaemon(adapter);

        server.send(
          createEnvelope(
            'task.offer',
            { instruction: 'x', policy: { mode: 'auto' } },
            { taskId: 'task-artifact-toctou-swap', seq: server.nextSeq() },
          ),
        );
        await server.waitFor((e) => e.type === 'task.started');
        await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
        const session = adapter.sessions[0]!;
        const workspaceDir = adapter.startCalls[0]!.ctx.workspaceDir;

        const swapName = 'swap-target.txt';
        const swapPath = path.join(workspaceDir, swapName);
        // The artifact starts life as a perfectly benign regular file —
        // exactly what a legitimately-behaving runtime would have written.
        await fs.writeFile(swapPath, 'benign content, at least at first', 'utf8');

        // `openArtifact` now calls `fs.realpath` TWICE (finding P4/Codex):
        // once on `workspaceDir` (unchanged), and once on the full candidate
        // path (the new intermediate-symlink containment check). That
        // second call closes what used to be the only remaining gap — a
        // *static* intermediate symlink is now caught before `fs.open()` is
        // ever reached. The one gap the fix still leaves (documented in
        // task-runner.ts) is narrower still: an intermediate directory
        // swapped to a symlink *after* that second realpath call resolves
        // but *before* the subsequent `fs.open()`. Spy on `fs.realpath` so
        // the swap lands deterministically inside exactly that gap — the
        // first call (workspaceDir) behaves normally, the second call (the
        // candidate) is where the swap is injected, right after it resolves
        // — instead of guessing microtask timing from outside. This proves
        // the actual security boundary for this narrowest window is the
        // `O_NOFOLLOW` open, not either realpath step: a swap timed exactly
        // here is still rejected.
        const originalRealpath = fs.realpath;
        const realpathSpy = vi.spyOn(fs, 'realpath');
        realpathSpy.mockImplementationOnce(async (p: Parameters<typeof fs.realpath>[0]) =>
          (originalRealpath as (p: unknown) => Promise<string>)(p),
        );
        realpathSpy.mockImplementationOnce(async (p: Parameters<typeof fs.realpath>[0]) => {
          const result = await (originalRealpath as (p: unknown) => Promise<string>)(p);
          unlinkSync(swapPath);
          symlinkSync('/etc/hosts', swapPath);
          return result;
        });

        session.emit({ type: 'artifact', name: swapName, contentType: 'text/plain' });
        session.emit({ type: 'turn_end' });

        await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-artifact-toctou-swap');
        // Both realpath calls happened (workspaceDir, then the candidate),
        // and the swap landed inside the second one, exactly as targeted.
        expect(realpathSpy).toHaveBeenCalledTimes(2);
        realpathSpy.mockRestore();

        expect(
          server.received.some((e) => e.type === 'task.artifact' && e.task_id === 'task-artifact-toctou-swap'),
        ).toBe(false);
        expect(server.httpRequests.some((r) => r.pathname === '/byok/blobs')).toBe(false);

        const progressWithError = server.received.find(
          (e) =>
            e.type === 'task.progress' &&
            e.task_id === 'task-artifact-toctou-swap' &&
            (e.payload as { events: Array<{ type: string; message?: string }> }).events.some(
              (ev) => ev.type === 'error' && ev.message?.includes(swapName),
            ),
        );
        expect(progressWithError).toBeDefined();
      });
    });
  });
});
