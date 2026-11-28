import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_FILE_MAX_BYTES,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  SKILL_PACK_MAX_BYTES,
  contentHash,
  skillPackContentHashInput,
} from '@byok-sdk/core';
import { CONFIGURED_SKILLS_MAX_ITEMS } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { OFFICIAL_LOCAL_AGENT_RELEASE } from '../bin/official-release';
import { checkDaemonConfig } from '../daemon/config-schema/check';
import { validateDaemonConfig } from '../daemon/config-schema/validate';
import { connectControlClient } from '../daemon/control-client';
import {
  CONTROL_PROTOCOL_VERSION,
  MAX_AUTHENTICATED_REQUEST_LINE_BYTES,
  MAX_LINE_BYTES,
  NdjsonLineReader,
  computeClientAuth,
  computeServerProof,
  controlEndpointPath,
  controlTokenPath,
  encodeFrame,
  parseServerHello,
  parseServerReady,
  randomNonceHex,
  toControlSkillRegistryStatus,
  type ControlStatusResult,
} from '../daemon/control-protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { resolveStorageConfig } from '../daemon/retention/config';
import { StoragePressure } from '../daemon/retention/pressure';
import { createRetentionRegistry } from '../daemon/retention/producers';
import { ScratchRoot } from '../daemon/retention/scratch';
import { RetentionSweeper } from '../daemon/retention/sweeper';
import {
  SKILL_PACK_LOCK_FILENAME,
  SKILL_PACK_LOCK_SCHEMA,
  skillPacksRoot,
} from '../daemon/skill-pack-installer';
import {
  SkillProjectionIntegrityError,
  projectResolvedSkills,
} from '../daemon/skill-projection';
import {
  SkillRegistry,
  SkillRegistryError,
  SkillRevisionConflictError,
} from '../daemon/skill-registry';
import type { ControlSkillReloadReceipt, SkillSource } from '../types';
import { acquirePathMutationGate, PathMutationGateBusyError } from '../util/path-mutation-gate';
import { testScratchRoot } from './fixtures/execution-scratch';
import { FRESH_DAEMON_EGRESS } from './fixtures/fresh-offer';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testAgentHomeConfig } from './fixtures/test-agent';
import { TestServer } from './fixtures/test-server';

const tempDirs: string[] = [];
const activeDaemons: Daemon[] = [];
const activeServers: TestServer[] = [];
const activeSweepers: RetentionSweeper[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(bytes: string | Uint8Array): ReturnType<typeof contentHash> {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  return contentHash(`sha256:${createHash('sha256').update(buf).digest('hex')}`);
}

function skillMarkdown(name: string, description: string, body = 'Follow the instructions.\n'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

async function writeLocalSkillDir(
  files: Readonly<Record<string, string>>,
  prefix = 'byok-skill-dir-',
): Promise<string> {
  const dir = await tmpDir(prefix);
  for (const [relative, content] of Object.entries(files)) {
    const abs = path.join(dir, ...relative.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return dir;
}

async function installSyntheticPack(
  dataDir: string,
  opts: {
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly files: Readonly<Record<string, string>>;
    readonly writeLock?: boolean;
  },
): Promise<{ readonly contentHash: string; readonly revisionDir: string; readonly lockPath: string }> {
  const fileEntries = Object.entries(opts.files).map(([rel, content]) => ({
    path: rel,
    content,
    contentHash: sha256(content),
    byteSize: Buffer.byteLength(content, 'utf8'),
  }));
  const packHash = sha256(
    skillPackContentHashInput({
      name: opts.name,
      version: opts.version,
      description: opts.description,
      files: fileEntries.map((entry) => ({
        path: entry.path,
        contentHash: entry.contentHash,
        byteSize: entry.byteSize,
      })),
    }),
  );
  const hex = (packHash as string).slice('sha256:'.length);
  const packRoot = path.join(skillPacksRoot(dataDir), opts.name);
  const revisionDir = path.join(packRoot, hex);
  await fs.mkdir(revisionDir, { recursive: true, mode: 0o700 });
  for (const entry of fileEntries) {
    const dest = path.join(revisionDir, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fs.writeFile(dest, entry.content, { encoding: 'utf8', mode: 0o600 });
  }
  const lockPath = path.join(packRoot, SKILL_PACK_LOCK_FILENAME);
  if (opts.writeLock !== false) {
    const lock = {
      schema: SKILL_PACK_LOCK_SCHEMA,
      name: opts.name,
      version: opts.version,
      description: opts.description,
      content_hash: packHash as string,
      source: 'https://skills.example',
      installed_at: '2026-11-28T00:00:00.000Z',
      files: fileEntries.map((entry) => ({
        path: entry.path,
        sha256: entry.contentHash as string,
        bytes: entry.byteSize,
      })),
    };
    await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  return {
    contentHash: packHash as string,
    revisionDir: await fs.realpath(revisionDir),
    lockPath,
  };
}

function expectRegistryError(fn: () => unknown, code: SkillRegistryError['code']): SkillRegistryError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SkillRegistryError);
  expect((thrown as SkillRegistryError).code).toBe(code);
  return thrown as SkillRegistryError;
}

afterEach(async () => {
  for (const sweeper of activeSweepers.splice(0)) await sweeper.stop();
  for (const daemon of activeDaemons.splice(0)) await daemon.stop();
  for (const server of activeServers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('SkillRegistry: source resolution ({ path } file vs directory, { pack })', () => {
  it('resolves a single SKILL.md file without sweeping sibling files in its parent directory', async () => {
    const folder = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: skillMarkdown('single-skill', 'Standalone skill.'),
      'unrelated.txt': 'must not be pinned or projected',
    });
    const skillFile = path.join(folder, SKILL_PACK_ENTRY_PATH);
    const registry = new SkillRegistry({ solo: { path: skillFile } });

    const snap = registry.snapshot();
    const resolved = snap.skills.get('solo')!;
    expect(resolved.id).toBe('solo');
    expect(resolved.sourceKind).toBe('file');
    expect(resolved.name).toBe('single-skill');
    expect(resolved.description).toBe('Standalone skill.');
    expect(resolved.rootDir).toBe(await fs.realpath(folder));
    expect(resolved.files.map((file) => file.path)).toEqual([SKILL_PACK_ENTRY_PATH]);
    expect(registry.status()).toEqual({
      revision: snap.revision,
      configuredSkills: ['solo'],
      skills: [
        {
          id: 'solo',
          source: { path: skillFile },
          name: 'single-skill',
          description: 'Standalone skill.',
          contentHash: resolved.contentHash,
          status: 'verified',
        },
      ],
    });

    const target = await tmpDir('byok-skill-single-proj-');
    const projected = await projectResolvedSkills([resolved], target);
    expect(await fs.readdir(projected[0]!.dir)).toEqual([SKILL_PACK_ENTRY_PATH]);
    await fs.writeFile(skillFile, skillMarkdown('single-skill', 'Mutated.'), 'utf8');
    await expect(projectResolvedSkills([resolved], await tmpDir('byok-skill-single-mut-'))).rejects.toThrow(
      SkillProjectionIntegrityError,
    );
  });

  it('resolves a directory with nested companion files deterministically and pins { pack } to its <content-hash> dir', async () => {
    const localDir = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: skillMarkdown('review-local', 'Review local diffs.'),
      'references/style.md': '# Style guide\n',
      'notes.md': 'Check edge cases.\n',
    });
    const dataDir = await tmpDir('byok-skill-store-');
    const installed = await installSyntheticPack(dataDir, {
      name: 'git-workflow',
      version: '1.2.3',
      description: 'Structured git workflow.',
      files: {
        [SKILL_PACK_ENTRY_PATH]: skillMarkdown('git-workflow', 'Structured git workflow.'),
        'references/commits.md': 'Keep commits atomic.\n',
      },
    });

    const registry = new SkillRegistry(
      {
        workflow: { pack: 'git-workflow' },
        review: { path: localDir },
      },
      { dataDir },
    );

    const snap = registry.snapshot();
    expect(snap.configuredSkills).toEqual(['review', 'workflow']);
    expect(snap.revision).toMatch(/^sha256:[0-9a-f]{64}$/);

    const review = snap.skills.get('review')!;
    expect(review.sourceKind).toBe('directory');
    expect(review.files.map((file) => file.path)).toEqual([SKILL_PACK_ENTRY_PATH, 'notes.md', 'references/style.md']);
    expect(review.packVersion).toBeUndefined();

    const workflow = snap.skills.get('workflow')!;
    expect(workflow.sourceKind).toBe('pack');
    expect(workflow.rootDir).toBe(installed.revisionDir);
    expect(workflow.packVersion).toBe('1.2.3');
    expect(workflow.contentHash).toBe(installed.contentHash);
    expect([...registry.pinnedPackDirectories()]).toEqual([installed.revisionDir]);
    expect(registry.status().skills.find((row) => row.id === 'workflow')).toMatchObject({
      id: 'workflow',
      source: { pack: 'git-workflow' },
      name: 'git-workflow',
      packVersion: '1.2.3',
      status: 'verified',
    });
    expect(toControlSkillRegistryStatus(registry.status()).skills).toEqual([
      { id: 'review', sourceKind: 'path', name: 'review-local', contentHash: review.contentHash, status: 'verified' },
      { id: 'workflow', sourceKind: 'pack', name: 'git-workflow', contentHash: workflow.contentHash, packVersion: '1.2.3', status: 'verified' },
    ]);
  });
});

describe('SkillRegistry: frontmatter, path, link, cap, and config rejections', () => {
  it.each(['exec', 'env', 'credential', 'hooks', 'allowed-tools'])(
    'rejects SKILL.md frontmatter declaring forbidden key %s',
    async (forbiddenKey) => {
      const dir = await writeLocalSkillDir({
        [SKILL_PACK_ENTRY_PATH]: `---\nname: bad-skill\ndescription: Reject me.\n${forbiddenKey}: danger\n---\n\nBody.\n`,
      });
      expectRegistryError(() => new SkillRegistry({ bad: { path: dir } }), 'frontmatter_invalid');
    },
  );

  it.each([
    ['missing name', '---\ndescription: No name.\n---\n\nBody.\n'],
    ['missing description', '---\nname: no-desc\n---\n\nBody.\n'],
    ['unclosed frontmatter', '---\nname: broken\ndescription: Missing end.\n'],
  ])('rejects invalid SKILL.md frontmatter (%s)', async (_label, content) => {
    const dir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: content });
    expectRegistryError(() => new SkillRegistry({ broken: { path: dir } }), 'frontmatter_invalid');
  });

  it('rejects missing SKILL.md, non-UTF-8 SKILL.md, and pack name mismatch', async () => {
    const emptyDir = await writeLocalSkillDir({ 'README.md': 'no entry file\n' });
    expectRegistryError(() => new SkillRegistry({ missing: { path: emptyDir } }), 'entry_missing');

    const badUtf8Dir = await tmpDir('byok-skill-utf8-');
    await fs.writeFile(path.join(badUtf8Dir, SKILL_PACK_ENTRY_PATH), Buffer.from([0xff, 0xfe, 0x00]));
    expectRegistryError(() => new SkillRegistry({ utf8: { path: badUtf8Dir } }), 'frontmatter_invalid');

    const dataDir = await tmpDir('byok-skill-pack-mismatch-');
    await installSyntheticPack(dataDir, {
      name: 'expected-name',
      version: '1.0.0',
      description: 'Mismatched frontmatter name.',
      files: {
        [SKILL_PACK_ENTRY_PATH]: skillMarkdown('other-name', 'Mismatched frontmatter name.'),
      },
    });
    expectRegistryError(() => new SkillRegistry({ mismatch: { pack: 'expected-name' } }, { dataDir }), 'frontmatter_invalid');
  });

  it('rejects prototype keys, invalid SkillIds, malformed SkillSource unions, relative paths, and >64 skills', async () => {
    const dir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('valid', 'Valid.') });
    for (const badId of ['prototype', 'constructor', 'UPPER', '-leading-dash', '']) {
      expectRegistryError(() => new SkillRegistry({ [badId]: { path: dir } }), 'invalid_skill_id');
    }
    const protoJson = JSON.parse(`{"__proto__": {"path": ${JSON.stringify(dir)}}}`) as Record<string, SkillSource>;
    expectRegistryError(() => new SkillRegistry(protoJson), 'invalid_skill_id');

    expectRegistryError(() => new SkillRegistry({ bad: {} as SkillSource }), 'invalid_config');
    expectRegistryError(
      () => new SkillRegistry({ bad: { path: dir, pack: 'p' } as unknown as SkillSource }),
      'invalid_config',
    );
    expectRegistryError(
      () => new SkillRegistry({ bad: { path: dir, extra: true } as unknown as SkillSource }),
      'invalid_config',
    );
    expectRegistryError(() => new SkillRegistry({ rel: { path: 'relative/SKILL.md' } }), 'path_not_absolute');

    const nonEntryFile = path.join(dir, 'other.md');
    await fs.writeFile(nonEntryFile, skillMarkdown('valid', 'Valid.'), 'utf8');
    expectRegistryError(() => new SkillRegistry({ other: { path: nonEntryFile } }), 'path_unsafe');

    const tooMany: Record<string, SkillSource> = {};
    for (let i = 0; i <= CONFIGURED_SKILLS_MAX_ITEMS; i++) {
      tooMany[`skill-${i}`] = { path: dir };
    }
    expectRegistryError(() => new SkillRegistry(tooMany), 'invalid_config');
  });

  it('rejects source.path over 4096 UTF-8 bytes and C0 control characters', async () => {
    const cases: readonly { readonly label: string; readonly rawPath: string }[] = [
      { label: 'ascii-4097-bytes', rawPath: `/${'a'.repeat(4096)}` },
      { label: 'multibyte-4099-bytes-1367-chars', rawPath: `/${'中'.repeat(1366)}` },
      { label: 'c0-nul', rawPath: '/tmp/skill\u0000a' },
      { label: 'c0-soh', rawPath: '/tmp/skill\u0001a' },
      { label: 'c0-tab', rawPath: '/tmp/skill\ta' },
      { label: 'c0-lf', rawPath: '/tmp/skill\na' },
      { label: 'c0-cr', rawPath: '/tmp/skill\ra' },
      { label: 'c0-us', rawPath: '/tmp/skill\u001fa' },
    ];
    for (const testCase of cases) {
      expectRegistryError(
        () => new SkillRegistry({ [testCase.label]: { path: testCase.rawPath } }),
        'path_unsafe',
      );
    }
  });

  it('rejects unsafe relative paths (dotfiles, bad characters) inside a skill directory', async () => {
    const dotfileDir = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: skillMarkdown('dot-skill', 'Has hidden file.'),
      '.env': 'SECRET=1\n',
    });
    expectRegistryError(() => new SkillRegistry({ dot: { path: dotfileDir } }), 'path_unsafe');

    const spaceDir = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: skillMarkdown('space-skill', 'Has unsafe path.'),
      'bad file.md': 'nope\n',
    });
    expectRegistryError(() => new SkillRegistry({ space: { path: spaceDir } }), 'path_unsafe');
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks (root, file, subdirectory, pack store) and hard links', async () => {
    const realDir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('real', 'Real skill.') });
    const linkParent = await tmpDir('byok-skill-link-');
    const rootLink = path.join(linkParent, 'linked-skill');
    await fs.symlink(realDir, rootLink);
    expectRegistryError(() => new SkillRegistry({ linked: { path: rootLink } }), 'symlink_forbidden');
    expectRegistryError(() => new SkillRegistry({ linked: { path: `${rootLink}${path.sep}` } }), 'symlink_forbidden');

    const decoyFile = path.join(linkParent, 'decoy.md');
    await fs.writeFile(decoyFile, 'decoy\n', 'utf8');
    const fileLinkDir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('file-link', 'Has file symlink.') });
    await fs.symlink(decoyFile, path.join(fileLinkDir, 'extra.md'));
    expectRegistryError(() => new SkillRegistry({ fl: { path: fileLinkDir } }), 'symlink_forbidden');

    const subLinkDir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('dir-link', 'Has dir symlink.') });
    const extSub = await tmpDir('byok-skill-ext-sub-');
    await fs.symlink(extSub, path.join(subLinkDir, 'references'));
    expectRegistryError(() => new SkillRegistry({ dl: { path: subLinkDir } }), 'symlink_forbidden');

    const hardLinkDir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('hardlink', 'Has hardlink.') });
    const hardTarget = path.join(linkParent, 'shared.md');
    await fs.writeFile(hardTarget, 'shared\n', 'utf8');
    await fs.link(hardTarget, path.join(hardLinkDir, 'linked.md'));
    expectRegistryError(() => new SkillRegistry({ hl: { path: hardLinkDir } }), 'hardlink_forbidden');

    const dataDir = await tmpDir('byok-skill-pack-symlink-');
    const installed = await installSyntheticPack(dataDir, {
      name: 'linked-pack',
      version: '1.0.0',
      description: 'Pack with symlinked file.',
      files: { [SKILL_PACK_ENTRY_PATH]: skillMarkdown('linked-pack', 'Pack with symlinked file.') },
    });
    await fs.rm(path.join(installed.revisionDir, SKILL_PACK_ENTRY_PATH));
    await fs.symlink(decoyFile, path.join(installed.revisionDir, SKILL_PACK_ENTRY_PATH));
    expectRegistryError(() => new SkillRegistry({ lp: { pack: 'linked-pack' } }, { dataDir }), 'symlink_forbidden');
  });

  it('enforces per-file byte cap, whole-skill byte cap, and file-count cap', async () => {
    const entry = skillMarkdown('capped', 'Capped skill.');

    const overFileDir = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: entry,
      'big.md': 'a'.repeat(SKILL_PACK_FILE_MAX_BYTES + 1),
    });
    expectRegistryError(() => new SkillRegistry({ overfile: { path: overFileDir } }), 'file_over_cap');

    const overTotalFiles: Record<string, string> = { [SKILL_PACK_ENTRY_PATH]: entry };
    // 5 files of 250 KiB each > 1 MiB total while each stays under 256 KiB.
    for (let i = 0; i < 5; i++) {
      overTotalFiles[`chunk-${i}.md`] = 'b'.repeat(250_000);
    }
    expect(5 * 250_000).toBeGreaterThan(SKILL_PACK_MAX_BYTES);
    const overTotalDir = await writeLocalSkillDir(overTotalFiles);
    expectRegistryError(() => new SkillRegistry({ overtotal: { path: overTotalDir } }), 'pack_over_cap');

    const overCountFiles: Record<string, string> = { [SKILL_PACK_ENTRY_PATH]: entry };
    for (let i = 0; i < 64; i++) {
      overCountFiles[`f-${i}.md`] = 'x\n';
    }
    const overCountDir = await writeLocalSkillDir(overCountFiles);
    expectRegistryError(() => new SkillRegistry({ overcount: { path: overCountDir } }), 'file_count_over_cap');
  });

  it('rejects missing paths, uninstalled packs, and tampered pack locks or directories', async () => {
    const missingPath = path.join(await tmpDir('byok-skill-missing-'), 'does-not-exist');
    expectRegistryError(() => new SkillRegistry({ ghost: { path: missingPath } }), 'path_not_found');

    const dataDir = await tmpDir('byok-skill-empty-store-');
    expectRegistryError(() => new SkillRegistry({ absent: { pack: 'missing-pack' } }, { dataDir }), 'pack_not_installed');

    const installed = await installSyntheticPack(dataDir, {
      name: 'tampered-pack',
      version: '1.0.0',
      description: 'Tampered pack.',
      files: { [SKILL_PACK_ENTRY_PATH]: skillMarkdown('tampered-pack', 'Tampered pack.') },
    });
    await fs.writeFile(path.join(installed.revisionDir, 'injected.md'), 'unpinned\n', 'utf8');
    expectRegistryError(() => new SkillRegistry({ tampered: { pack: 'tampered-pack' } }, { dataDir }), 'pack_corrupt');
  });
});

describe('SkillRegistry: CAS reload, no-op, and invalid reload rollback', () => {
  it('treats same-content reload as a no-op, enforces CAS revision, and preserves snapshot A on invalid reload', async () => {
    const dirA = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: skillMarkdown('skill-a', 'Version A.', 'Body A.\n'),
    });
    const badDir = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: '---\nname: skill-bad\ndescription: Bad.\nexec: sh\n---\n',
    });

    const registry = new SkillRegistry({ review: { path: dirA } });
    const initial = registry.snapshot();

    const noop = registry.reload({ review: { path: dirA } }, initial.revision);
    expect(noop).toMatchObject({
      previousRevision: initial.revision,
      revision: initial.revision,
      changed: false,
      configuredSkills: ['review'],
    });
    expect(registry.snapshot()).toBe(initial);

    expectRegistryError(() => registry.reload({}, 'not-a-revision'), 'invalid_revision');
    expect(() => registry.reload({}, `sha256:${'0'.repeat(64)}`)).toThrow(SkillRevisionConflictError);

    expectRegistryError(() => registry.reload({ review: { path: badDir } }, initial.revision), 'frontmatter_invalid');
    expect(registry.snapshot()).toBe(initial);
    expect(registry.status().revision).toBe(initial.revision);

    // Mutate content under the same config path -> reload picks up new content revision.
    await fs.writeFile(path.join(dirA, SKILL_PACK_ENTRY_PATH), skillMarkdown('skill-a', 'Version B.', 'Body B.\n'), 'utf8');
    const updated = registry.reload({ review: { path: dirA } }, initial.revision);
    expect(updated.changed).toBe(true);
    expect(updated.previousRevision).toBe(initial.revision);
    expect(updated.revision).not.toBe(initial.revision);
    expect(updated.skills[0]?.description).toBe('Version B.');
  });
});

describe('A/B integrity contract (#7221522492) & projectResolvedSkills', () => {
  it('refuses local { path } byte mutation, deletion, unexpected file, and symlink/hardlink swaps without projecting B under A', async () => {
    const bodyA = skillMarkdown('review', 'Review skill.', 'Guideline AAAA.\n');
    const bodyBSameLength = skillMarkdown('review', 'Review skill.', 'Guideline BBBB.\n');
    expect(Buffer.byteLength(bodyBSameLength)).toBe(Buffer.byteLength(bodyA));

    const dir = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: bodyA,
      'references/check.md': 'Check A.\n',
    });
    const registry = new SkillRegistry({ review: { path: dir } });
    const snapA = registry.snapshot();
    const skillA = snapA.skills.get('review')!;

    // Clean projection of A: copied bytes (never symlinks), 0700 dirs, 0600 files.
    const targetClean = await tmpDir('byok-skill-proj-a-');
    const projectedA = await projectResolvedSkills([skillA], targetClean);
    expect(projectedA).toHaveLength(1);
    expect(path.basename(projectedA[0]!.dir)).toBe('0-review');
    expect(await fs.readFile(path.join(projectedA[0]!.dir, SKILL_PACK_ENTRY_PATH), 'utf8')).toBe(bodyA);
    expect(await fs.readFile(path.join(projectedA[0]!.dir, 'references/check.md'), 'utf8')).toBe('Check A.\n');
    expect((await fs.lstat(path.join(projectedA[0]!.dir, SKILL_PACK_ENTRY_PATH))).isSymbolicLink()).toBe(false);
    if (process.platform !== 'win32') {
      expect((await fs.stat(projectedA[0]!.dir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(projectedA[0]!.dir, SKILL_PACK_ENTRY_PATH))).mode & 0o777).toBe(0o600);
    }

    // 1) Same-length byte mutation A -> B without reload -> refused (hash mismatch), never projects B under A.
    await fs.writeFile(path.join(dir, SKILL_PACK_ENTRY_PATH), bodyBSameLength, 'utf8');
    const targetMutated = await tmpDir('byok-skill-proj-mut-');
    await expect(projectResolvedSkills([skillA], targetMutated)).rejects.toMatchObject({
      name: 'SkillProjectionIntegrityError',
      reason: 'file_hash_mismatch',
      skillId: 'review',
    });
    expect(await fs.readdir(targetMutated)).toEqual([]);

    // Restore A, then 2) add an unexpected extra file -> refused (unexpected_file).
    await fs.writeFile(path.join(dir, SKILL_PACK_ENTRY_PATH), bodyA, 'utf8');
    const extraFile = path.join(dir, 'extra.md');
    await fs.writeFile(extraFile, 'sneaky\n', 'utf8');
    const targetExtra = await tmpDir('byok-skill-proj-extra-');
    await expect(projectResolvedSkills([skillA], targetExtra)).rejects.toMatchObject({
      name: 'SkillProjectionIntegrityError',
      reason: 'unexpected_file',
    });
    await fs.rm(extraFile);

    // 3) Delete a pinned companion file -> refused (file_missing).
    const checkPath = path.join(dir, 'references/check.md');
    await fs.rm(checkPath);
    const targetDeleted = await tmpDir('byok-skill-proj-del-');
    await expect(projectResolvedSkills([skillA], targetDeleted)).rejects.toMatchObject({
      name: 'SkillProjectionIntegrityError',
      reason: 'file_missing',
    });

    // 4) Replace pinned file with a symlink (POSIX) or hardlink -> refused.
    const decoy = path.join(await tmpDir('byok-skill-decoy-'), 'decoy.md');
    await fs.writeFile(decoy, 'Check A.\n', 'utf8');
    if (process.platform !== 'win32') {
      await fs.symlink(decoy, checkPath);
      await expect(projectResolvedSkills([skillA], await tmpDir('byok-skill-proj-sym-'))).rejects.toMatchObject({
        name: 'SkillProjectionIntegrityError',
        reason: 'symlink_detected',
      });
      await fs.rm(checkPath);
      await fs.link(decoy, checkPath);
      await expect(projectResolvedSkills([skillA], await tmpDir('byok-skill-proj-hl-'))).rejects.toMatchObject({
        name: 'SkillProjectionIntegrityError',
        reason: 'hardlink_detected',
      });
      await fs.rm(checkPath);
    }

    // 5) Restore companion file, mutate to B, reload -> next projection receives verified B.
    await fs.writeFile(checkPath, 'Check B.\n', 'utf8');
    await fs.writeFile(path.join(dir, SKILL_PACK_ENTRY_PATH), bodyBSameLength, 'utf8');
    const reloaded = registry.reload({ review: { path: dir } }, snapA.revision);
    expect(reloaded.changed).toBe(true);
    const skillB = registry.snapshot().skills.get('review')!;
    const projectedB = await projectResolvedSkills([skillB], await tmpDir('byok-skill-proj-b-'));
    expect(await fs.readFile(path.join(projectedB[0]!.dir, SKILL_PACK_ENTRY_PATH), 'utf8')).toBe(bodyBSameLength);
    expect(await fs.readFile(path.join(projectedB[0]!.dir, 'references/check.md'), 'utf8')).toBe('Check B.\n');
  });

  it('pins { pack } to <content-hash> dir: projects verified A even after lock.json moves to B, refuses if A dir is deleted, and switches to B only after reload', async () => {
    const dataDir = await tmpDir('byok-skill-pack-ab-');
    const contentA = skillMarkdown('review-pack', 'Pack A.', 'Pack body A.\n');
    const contentB = skillMarkdown('review-pack', 'Pack B.', 'Pack body B.\n');

    const packA = await installSyntheticPack(dataDir, {
      name: 'review-pack',
      version: '1.0.0',
      description: 'Pack A.',
      files: { [SKILL_PACK_ENTRY_PATH]: contentA },
    });

    const registry = new SkillRegistry({ review: { pack: 'review-pack' } }, { dataDir });
    const snapA = registry.snapshot();
    const skillA = snapA.skills.get('review')!;
    expect(skillA.rootDir).toBe(packA.revisionDir);

    // Install pack B: lock.json now points to B, while pack A's <content-hash> dir still exists.
    const packB = await installSyntheticPack(dataDir, {
      name: 'review-pack',
      version: '2.0.0',
      description: 'Pack B.',
      files: { [SKILL_PACK_ENTRY_PATH]: contentB },
    });
    expect(packB.revisionDir).not.toBe(packA.revisionDir);

    // Without reloading, snapshot A STILL projects verified A (never silently following lock.json to B).
    const projectedStillA = await projectResolvedSkills([skillA], await tmpDir('byok-skill-pack-still-a-'));
    expect(await fs.readFile(path.join(projectedStillA[0]!.dir, SKILL_PACK_ENTRY_PATH), 'utf8')).toBe(contentA);

    // Delete pack A's pinned dir without reloading -> refuses with SkillProjectionIntegrityError, never falls back to B.
    await fs.rm(packA.revisionDir, { recursive: true, force: true });
    const targetDeletedA = await tmpDir('byok-skill-pack-del-a-');
    await expect(projectResolvedSkills([skillA], targetDeletedA)).rejects.toThrow(SkillProjectionIntegrityError);
    await expect(projectResolvedSkills([skillA], targetDeletedA)).rejects.toMatchObject({
      reason: 'root_missing',
      skillId: 'review',
    });
    expect(await fs.readdir(targetDeletedA)).toEqual([]);

    // After reload, snapshot pins B and projects verified B.
    const reloaded = registry.reload({ review: { pack: 'review-pack' } }, snapA.revision);
    expect(reloaded.changed).toBe(true);
    expect(reloaded.skills[0]?.packVersion).toBe('2.0.0');
    const skillB = registry.snapshot().skills.get('review')!;
    const projectedB = await projectResolvedSkills([skillB], await tmpDir('byok-skill-pack-b-'));
    expect(await fs.readFile(path.join(projectedB[0]!.dir, SKILL_PACK_ENTRY_PATH), 'utf8')).toBe(contentB);
  });

  it('refuses a pre-existing target directory without deleting pre-existing user files', async () => {
    const dir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('safe', 'Safe.') });
    const skill = new SkillRegistry({ safe: { path: dir } }).snapshot().skills.get('safe')!;
    const targetRoot = await tmpDir('byok-skill-preexisting-');
    const preExistingDir = path.join(targetRoot, '0-safe');
    await fs.mkdir(preExistingDir, { mode: 0o700 });
    const userFile = path.join(preExistingDir, 'keep.txt');
    await fs.writeFile(userFile, 'user data', 'utf8');

    await expect(projectResolvedSkills([skill], targetRoot)).rejects.toMatchObject({
      name: 'SkillProjectionIntegrityError',
      reason: 'target_unsafe',
    });
    expect(await fs.readFile(userFile, 'utf8')).toBe('user data');
  });
});

describe('Retention protection & skill-pack-store path mutation gate', () => {
  it('protects pinned pack directories from skill-pack-old sweeps while reclaiming unpinned revisions and post-reload old revisions', async () => {
    const storeDir = await tmpDir('byok-skill-retention-');
    const packA = await installSyntheticPack(storeDir, {
      name: 'pinned-pack',
      version: '1.0.0',
      description: 'Pack A.',
      files: { [SKILL_PACK_ENTRY_PATH]: skillMarkdown('pinned-pack', 'Pack A.', 'A\n') },
    });
    const registry = new SkillRegistry({ s: { pack: 'pinned-pack' } }, { dataDir: storeDir });

    // Create an unpinned older revision C (no lock) and then move lock.json to B.
    const packC = await installSyntheticPack(storeDir, {
      name: 'pinned-pack',
      version: '0.9.0',
      description: 'Pack C.',
      files: { [SKILL_PACK_ENTRY_PATH]: skillMarkdown('pinned-pack', 'Pack C.', 'C\n') },
      writeLock: false,
    });
    const packB = await installSyntheticPack(storeDir, {
      name: 'pinned-pack',
      version: '2.0.0',
      description: 'Pack B.',
      files: { [SKILL_PACK_ENTRY_PATH]: skillMarkdown('pinned-pack', 'Pack B.', 'B\n') },
    });

    // Backdate A and C well past the 24h skill-pack-old TTL.
    const ancient = new Date('2026-10-01T00:00:00.000Z');
    await fs.utimes(packA.revisionDir, ancient, ancient);
    await fs.utimes(packC.revisionDir, ancient, ancient);

    const now = new Date('2026-11-28T00:00:00.000Z');
    const storageConfig = resolveStorageConfig(storeDir, { scratchRoot: testScratchRoot() });
    const scratch = new ScratchRoot(storageConfig.scratchRoot, () => now);
    await scratch.open(storeDir);
    const retentionRegistry = createRetentionRegistry({
      storeDir,
      scratch,
      config: storageConfig,
      clock: () => now,
      journal: () => undefined,
      identity: () => undefined,
      preparation: () => undefined,
      pinnedSkillPackDirs: () => registry.pinnedPackDirectories(),
    });
    const sweeper = new RetentionSweeper({
      registry: retentionRegistry,
      config: storageConfig,
      clock: () => now,
      pressure: new StoragePressure(),
      freeBytes: async () => 1_000_000_000,
      jitter: (_seq, ms) => ms,
    });
    activeSweepers.push(sweeper);

    await sweeper.runPass('periodic');
    // Pinned A and locked B survive; unpinned C is swept.
    await expect(fs.stat(packA.revisionDir)).resolves.toBeDefined();
    await expect(fs.stat(packB.revisionDir)).resolves.toBeDefined();
    await expect(fs.stat(packC.revisionDir)).rejects.toThrow();

    // Pass 1 measured before sweeping: only unpinned C belonged to `skill-pack-old` (not pinned A).
    const preSweepOld = sweeper.snapshot().classes.find((entry) => entry.classId === 'skill-pack-old');
    const packCBytes = Buffer.byteLength(skillMarkdown('pinned-pack', 'Pack C.', 'C\n'), 'utf8');
    expect(preSweepOld?.bytes).toBe(packCBytes);

    // Post-sweep measurement: pinned A and locked B are both protected `skill-pack-current`, with 0 bytes in `skill-pack-old`.
    const postSweepClasses = await retentionRegistry.measure();
    expect(postSweepClasses.find((entry) => entry.classId === 'skill-pack-old')?.bytes).toBe(0);
    expect(postSweepClasses.find((entry) => entry.classId === 'skill-pack-current')?.bytes).toBeGreaterThan(packCBytes);

    // Once reload moves the snapshot to B, A is no longer pinned and the next sweep reclaims it.
    registry.reload({ s: { pack: 'pinned-pack' } }, registry.snapshot().revision);
    await sweeper.runPass('periodic');
    await expect(fs.stat(packA.revisionDir)).rejects.toThrow();
    await expect(fs.stat(packB.revisionDir)).resolves.toBeDefined();
  });

  it('acquires the skill-pack-store path mutation gate while projecting { pack } skills', async () => {
    const dataDir = await tmpDir('byok-skill-gate-');
    await installSyntheticPack(dataDir, {
      name: 'gated-pack',
      version: '1.0.0',
      description: 'Gated pack.',
      files: { [SKILL_PACK_ENTRY_PATH]: skillMarkdown('gated-pack', 'Gated pack.') },
    });
    const skill = new SkillRegistry({ gated: { pack: 'gated-pack' } }, { dataDir }).snapshot().skills.get('gated')!;

    const heldGate = await acquirePathMutationGate({
      scope: 'skill-pack-store',
      targetPath: skillPacksRoot(dataDir),
    });
    try {
      await expect(projectResolvedSkills([skill], await tmpDir('byok-skill-gate-out-'))).rejects.toThrow(
        PathMutationGateBusyError,
      );
    } finally {
      await heldGate.release();
    }

    // After releasing the gate, projection succeeds cleanly.
    const projected = await projectResolvedSkills([skill], await tmpDir('byok-skill-gate-ok-'));
    expect(projected).toHaveLength(1);
  });
});

describe('DaemonConfig.skills schema, Daemon.status().skills, reloadSkills, and control socket skills.reload', () => {
  it('validates DaemonConfig.skills in validateDaemonConfig and checkDaemonConfig with redacted effective summary', async () => {
    const base = { productName: 'Acme', productId: 'acme-skills-schema', serverUrl: 'https://acme.example' };
    const skillDir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('schema-skill', 'Schema checked.') });
    const storeDir = await tmpDir('byok-skills-check-store-');

    expect(
      validateDaemonConfig(
        { ...base, skills: { local: { path: skillDir }, packed: { pack: 'git-workflow' } } },
        { source: 'cli' },
      ),
    ).toEqual({ ok: true, issues: [] });

    const invalidBoth = validateDaemonConfig(
      { ...base, skills: { bad: { path: skillDir, pack: 'git-workflow' } } },
      { source: 'cli' },
    );
    expect(invalidBoth.ok).toBe(false);
    expect(invalidBoth.issues[0]?.path).toContain('skills.bad');

    const invalidEmpty = validateDaemonConfig({ ...base, skills: { bad: {} } }, { source: 'cli' });
    expect(invalidEmpty.ok).toBe(false);

    const check = checkDaemonConfig(
      { ...base, storeDir, storage: { scratchRoot: testScratchRoot() }, agentMemoryMcp: 'off', skills: { local: { path: skillDir } } },
      { source: 'cli', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE, adapters: [] },
    );
    expect(check.ok).toBe(true);
    expect(check.effective?.skills.entries).toEqual([
      {
        id: 'local',
        sourceKind: 'path',
        name: 'schema-skill',
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    ]);
    // Local filesystem path stays redacted out of effective.skills.
    expect(JSON.stringify(check.effective?.skills)).not.toContain(skillDir);

    const checkInvalid = checkDaemonConfig(
      { ...base, storeDir, storage: { scratchRoot: testScratchRoot() }, agentMemoryMcp: 'off', skills: { bad: { path: path.join(storeDir, 'missing') } } },
      { source: 'cli', localAgentRelease: OFFICIAL_LOCAL_AGENT_RELEASE, adapters: [] },
    );
    expect(checkInvalid.ok).toBe(false);
  });

  it('wires Daemon.status().skills, Daemon.reloadSkills, and control-socket skills.reload end to end', async () => {
    const server = await TestServer.start();
    activeServers.push(server);
    const storeDir = await tmpDir('byok-daemon-skills-store-');
    const dirA = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('alpha', 'Alpha skill.', 'Alpha.\n') });
    const dirB = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: skillMarkdown('beta', 'Beta skill.', 'Beta.\n') });
    const badDir = await writeLocalSkillDir({ [SKILL_PACK_ENTRY_PATH]: '---\nname: bad\ndescription: Bad.\nallowed-tools: Bash\n---\n' });

    const config: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Acme',
      productId: 'acme-daemon-skills',
      serverUrl: server.url,
      storeDir,
      agentHome: testAgentHomeConfig(),
      agentEgress: FRESH_DAEMON_EGRESS,
      storage: { scratchRoot: testScratchRoot() },
      skills: { alpha: { path: dirA } },
    };
    const daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')]);
    activeDaemons.push(daemon);

    expect(daemon.status().skills.configuredSkills).toEqual(['alpha']);
    expect(daemon.status().config.skills.revision).toBe(daemon.status().skills.revision);
    expect(JSON.stringify(daemon.status().config.skills)).not.toContain(dirA);

    // Direct Daemon.reloadSkills CAS + no-op + rollback.
    const rev1 = daemon.status().skills.revision;
    expect(daemon.reloadSkills({ alpha: { path: dirA } }, rev1).changed).toBe(false);
    expect(() => daemon.reloadSkills({}, `sha256:${'0'.repeat(64)}`)).toThrow(SkillRevisionConflictError);
    expectRegistryError(() => daemon.reloadSkills({ alpha: { path: badDir } }, rev1), 'frontmatter_invalid');
    expect(daemon.status().skills.revision).toBe(rev1);

    await daemon.pair('pairing-code');
    await daemon.start();
    await waitForDaemonOpen(daemon);

    const conn = await connectControlClient({ storeDir, productId: config.productId });
    if (!conn.ok) throw new Error(`expected control socket: ${conn.reason}`);
    try {
      const statusBefore = await conn.client.request<ControlStatusResult>('status');
      expect(statusBefore.skills).toEqual(toControlSkillRegistryStatus(daemon.status().skills));
      expect(statusBefore.skills?.skills).toEqual([
        {
          id: 'alpha',
          sourceKind: 'path',
          name: 'alpha',
          contentHash: daemon.status().skills.skills[0]!.contentHash,
          status: 'verified',
        },
      ]);
      expect(JSON.stringify(statusBefore.skills)).not.toContain(dirA);
      expect(JSON.stringify(statusBefore.skills)).not.toContain('Alpha skill.');
      // In-process Daemon.status().skills keeps source and description (#2562).
      expect(daemon.status().skills.skills[0]).toMatchObject({
        source: { path: dirA },
        description: 'Alpha skill.',
      });

      const receipt = await conn.client.request<ControlSkillReloadReceipt>('skills.reload', {
        expectedRevision: rev1,
        skills: { alpha: { path: dirA }, beta: { path: dirB } },
      });
      expect(receipt.changed).toBe(true);
      expect(receipt.previousRevision).toBe(rev1);
      expect(receipt.configuredSkills).toEqual(['alpha', 'beta']);
      expect(receipt.skills.every((row) => row.sourceKind === 'path' && !('source' in row) && !('description' in row))).toBe(true);
      expect(JSON.stringify(receipt)).not.toContain(dirA);
      expect(JSON.stringify(receipt)).not.toContain(dirB);
      expect(daemon.status().skills.revision).toBe(receipt.revision);

      // Stale revision -> revision_conflict.
      await expect(
        conn.client.request('skills.reload', { expectedRevision: rev1, skills: {} }),
      ).rejects.toMatchObject({ code: 'revision_conflict' });

      // Invalid skill content -> structured SkillRegistryError code, snapshot preserved.
      await expect(
        conn.client.request('skills.reload', {
          expectedRevision: receipt.revision,
          skills: { bad: { path: badDir } },
        }),
      ).rejects.toMatchObject({ code: 'frontmatter_invalid' });
      expect(daemon.status().skills.revision).toBe(receipt.revision);

      // Malformed RPC wrapper -> bad_request.
      await expect(
        conn.client.request('skills.reload', { expectedRevision: receipt.revision }),
      ).rejects.toMatchObject({ code: 'bad_request' });
    } finally {
      conn.client.close();
    }
  });

  it('enforces NdjsonLineReader unterminated-line bounds before and after setMaxLineBytes', () => {
    const preAuth = new NdjsonLineReader();
    expect(preAuth.push(Buffer.from(`${'a'.repeat(MAX_LINE_BYTES)}\n`))).toHaveLength(1);
    expect(() => preAuth.push(Buffer.from('a'.repeat(MAX_LINE_BYTES + 1)))).toThrow(
      `NDJSON line exceeded ${MAX_LINE_BYTES} bytes without a terminating newline`,
    );

    const postAuth = new NdjsonLineReader();
    postAuth.setMaxLineBytes(MAX_AUTHENTICATED_REQUEST_LINE_BYTES);
    const largeLine = 'b'.repeat(200 * 1024);
    expect(postAuth.push(Buffer.from(`${largeLine}\n`))).toEqual([largeLine]);
    expect(() => postAuth.push(Buffer.from('c'.repeat(MAX_AUTHENTICATED_REQUEST_LINE_BYTES + 1)))).toThrow(
      `NDJSON line exceeded ${MAX_AUTHENTICATED_REQUEST_LINE_BYTES} bytes without a terminating newline`,
    );
  });

  it('handles 64 max-CJK skills and >64 KiB authenticated skills.reload over control IPC while refusing oversized pre-auth and post-auth frames', async () => {
    const server = await TestServer.start();
    activeServers.push(server);
    const storeDir = await tmpDir('byok-daemon-skills-ipc-64-');
    const cjkDescription = '技'.repeat(1024);
    const skillDir = await writeLocalSkillDir({
      [SKILL_PACK_ENTRY_PATH]: skillMarkdown('cjk-skill', cjkDescription, 'Body.\n'),
    });

    // 64 valid sources with ~2.5 KiB `./`-padded absolute paths (<= 4096 UTF-8 bytes each,
    // > 170 KiB total inbound NDJSON frame) and 1024-char CJK descriptions (~3 KiB each).
    const paddedRoot = path.parse(skillDir).root;
    const relativeToRoot = skillDir.slice(paddedRoot.length);
    const padCount = Math.floor((2750 - skillDir.length) / 2);
    const paddedPath = `${paddedRoot}${'./'.repeat(padCount)}${relativeToRoot}`;
    expect(Buffer.byteLength(paddedPath, 'utf8')).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(paddedPath, 'utf8')).toBeGreaterThan(2700);

    const sixtyFourSkills: Record<string, SkillSource> = {};
    for (let i = 0; i < CONFIGURED_SKILLS_MAX_ITEMS; i++) {
      sixtyFourSkills[`skill-${String(i).padStart(2, '0')}`] = { path: paddedPath };
    }
    const inboundBytes = Buffer.byteLength(
      encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id: 'c1', method: 'skills.reload', params: { expectedRevision: `sha256:${'0'.repeat(64)}`, skills: sixtyFourSkills } }),
      'utf8',
    );
    expect(inboundBytes).toBeGreaterThan(172_500);
    expect(inboundBytes).toBeLessThan(MAX_AUTHENTICATED_REQUEST_LINE_BYTES);

    const config: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Acme',
      productId: 'acme-daemon-skills-ipc-64',
      serverUrl: server.url,
      storeDir,
      agentHome: testAgentHomeConfig(),
      agentEgress: FRESH_DAEMON_EGRESS,
      storage: { scratchRoot: testScratchRoot() },
    };
    const daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter('pi')]);
    activeDaemons.push(daemon);
    await daemon.pair('pairing-code');
    await daemon.start();
    await waitForDaemonOpen(daemon);

    const conn = await connectControlClient({ storeDir, productId: config.productId });
    if (!conn.ok) throw new Error(`expected control socket: ${conn.reason}`);
    try {
      const initialStatus = await conn.client.request<ControlStatusResult>('status');
      const receipt = await conn.client.request<ControlSkillReloadReceipt>('skills.reload', {
        expectedRevision: initialStatus.skills!.revision,
        skills: sixtyFourSkills,
      });
      expect(receipt.changed).toBe(true);
      expect(receipt.configuredSkills).toHaveLength(CONFIGURED_SKILLS_MAX_ITEMS);
      expect(receipt.skills).toHaveLength(CONFIGURED_SKILLS_MAX_ITEMS);
      expect(Buffer.byteLength(encodeFrame({ v: 1, id: 'c1', ok: true, result: receipt }), 'utf8')).toBeLessThan(MAX_LINE_BYTES);
      expect(JSON.stringify(receipt)).not.toContain(cjkDescription);
      expect(JSON.stringify(receipt)).not.toContain(paddedPath);

      const liveStatus = await conn.client.request<ControlStatusResult>('status');
      expect(liveStatus.skills?.skills).toHaveLength(CONFIGURED_SKILLS_MAX_ITEMS);
      expect(Buffer.byteLength(encodeFrame({ v: 1, id: 'c2', ok: true, result: liveStatus }), 'utf8')).toBeLessThan(MAX_LINE_BYTES);
      expect(JSON.stringify(liveStatus.skills)).not.toContain(cjkDescription);

      // In-process Daemon.status().skills still carries the raw source and CJK description.
      expect(daemon.status().skills.skills).toHaveLength(CONFIGURED_SKILLS_MAX_ITEMS);
      expect(daemon.status().skills.skills[0]?.description).toBe(cjkDescription);
    } finally {
      conn.client.close();
    }

    const endpoint = controlEndpointPath(config.productId, storeDir);
    const token = (await fs.readFile(controlTokenPath(storeDir), 'utf8')).trim();
    const waitClosed = (socket: net.Socket): Promise<void> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('socket did not close')), 3000);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });

    // Pre-auth unterminated frame > 64 KiB is refused fail-closed.
    const preAuthSocket = net.createConnection(endpoint);
    preAuthSocket.on('error', () => {});
    const preAuthClosed = waitClosed(preAuthSocket);
    preAuthSocket.once('connect', () => {
      preAuthSocket.write(`{"v":1,"hello":"client","nonce":"${'a'.repeat(MAX_LINE_BYTES + 128)}`);
    });
    await preAuthClosed;

    // Post-auth unterminated frame > 1 MiB is refused fail-closed.
    const postAuthSocket = net.createConnection(endpoint);
    postAuthSocket.on('error', () => {});
    const postAuthClosed = waitClosed(postAuthSocket);
    const clientNonce = randomNonceHex();
    const rawReader = new NdjsonLineReader();
    let phase: 'server-hello' | 'ready' | 'done' = 'server-hello';
    postAuthSocket.on('data', (chunk: Buffer) => {
      for (const line of rawReader.push(chunk)) {
        const parsed = JSON.parse(line) as unknown;
        if (phase === 'server-hello') {
          const hello = parseServerHello(parsed);
          if (!hello || hello.proof !== computeServerProof(token, clientNonce)) {
            postAuthSocket.destroy();
            return;
          }
          postAuthSocket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, auth: computeClientAuth(token, hello.nonce) }));
          phase = 'ready';
        } else if (phase === 'ready' && parseServerReady(parsed)) {
          phase = 'done';
          postAuthSocket.write(`{"v":1,"id":"oversize","method":"skills.reload","params":{"pad":"${'z'.repeat(MAX_AUTHENTICATED_REQUEST_LINE_BYTES + 128)}`);
        }
      }
    });
    postAuthSocket.once('connect', () => {
      postAuthSocket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, hello: 'client', nonce: clientNonce }));
    });
    await postAuthClosed;
  });
});
