import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import {
  SKILL_PACK_FILE_PATH_PATTERN,
  checkSkillPackFileContent,
  contentHash,
  isSkillPackPathSafe,
  type ContentHash,
} from '@byok-sdk/core';
import type { ProjectedSkill } from '../types.js';
import { atomicWriteFile } from '../util/atomic-write.js';
import { compareCodeUnits } from '../util/compare-code-units.js';
import { sameContent } from '../util/file-state.js';
import {
  acquirePathMutationGates,
  withGateReleaseFailures,
  type PathMutationGate,
} from '../util/path-mutation-gate.js';
import type { PinnedSkillFile, ResolvedSkillSnapshot } from './skill-registry.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PACK_STORE_GATE_WAIT_MS = 1_000;

export const SKILL_PROJECTION_INTEGRITY_REASONS = [
  'target_unsafe',
  'root_missing',
  'root_unsafe',
  'symlink_detected',
  'hardlink_detected',
  'unexpected_entry',
  'unexpected_file',
  'file_missing',
  'file_size_mismatch',
  'file_hash_mismatch',
  'file_changed_during_read',
  'path_unsafe',
] as const;

export type SkillProjectionIntegrityReason = (typeof SKILL_PROJECTION_INTEGRITY_REASONS)[number];

/**
 * Raised when a pinned skill snapshot can no longer be verified byte-for-byte
 * on disk during pre-claim projection (missing file, symlink/hardlink swap,
 * byte drift, or unexpected files). Callers must decline non-retryably before
 * claim and never project newer bytes under an older snapshot's revision.
 */
export class SkillProjectionIntegrityError extends Error {
  readonly reason: SkillProjectionIntegrityReason;
  readonly skillId: string;
  readonly filePath: string | undefined;

  constructor(
    reason: SkillProjectionIntegrityReason,
    skillId: string,
    message: string,
    options: { readonly cause?: unknown; readonly filePath?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SkillProjectionIntegrityError';
    this.reason = reason;
    this.skillId = skillId;
    this.filePath = options.filePath;
  }
}

function hashBytes(bytes: Uint8Array): ContentHash {
  return contentHash(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Ensures `root` (and each `/`-separated relative segment below it) is a real,
 * non-symlink directory with mode `0700`. Ancestors above `root` may have
 * platform aliases (e.g. macOS `/var`); every created or checked component at
 * or below `root` must stay pinned in place.
 */
async function checkedTargetDirectory(
  root: string,
  relative: string,
  skillId: string,
): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const requireDirectory = async (directory: string, recursive = false): Promise<void> => {
    let stats: BigIntStats;
    try {
      stats = await fs.lstat(directory, { bigint: true });
    } catch (cause) {
      if (isErrno(cause, 'ENOTDIR')) {
        throw new SkillProjectionIntegrityError(
          'target_unsafe',
          skillId,
          `projection target ${directory} has a non-directory ancestor`,
          { cause },
        );
      }
      if (!isErrno(cause, 'ENOENT')) {
        throw new SkillProjectionIntegrityError(
          'target_unsafe',
          skillId,
          `failed to stat projection target ${directory}`,
          { cause },
        );
      }
      await fs.mkdir(directory, { recursive, mode: DIR_MODE });
      stats = await fs.lstat(directory, { bigint: true });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SkillProjectionIntegrityError(
        'target_unsafe',
        skillId,
        `projection target ${directory} is not a non-symlink directory`,
      );
    }
    if (process.platform !== 'win32') {
      await fs.chmod(directory, DIR_MODE);
    }
  };

  await requireDirectory(absoluteRoot, true);
  const canonicalRoot = await fs.realpath(absoluteRoot);
  let directory = canonicalRoot;
  for (const part of relative === '' ? [] : relative.split('/')) {
    directory = path.join(directory, part);
    await requireDirectory(directory);
    if ((await fs.realpath(directory)) !== directory) {
      throw new SkillProjectionIntegrityError(
        'target_unsafe',
        skillId,
        `projection target ${directory} resolves outside its checked directory chain`,
      );
    }
  }
  return directory;
}

async function assertSourceRootCanonical(skill: ResolvedSkillSnapshot): Promise<void> {
  let stat: BigIntStats;
  try {
    stat = await fs.lstat(skill.rootDir, { bigint: true });
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) {
      throw new SkillProjectionIntegrityError(
        'root_missing',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} root directory no longer exists`,
        { cause },
      );
    }
    throw new SkillProjectionIntegrityError(
      'root_unsafe',
      skill.id,
      `failed to stat pinned skill ${JSON.stringify(skill.id)} root directory`,
      { cause },
    );
  }
  if (stat.isSymbolicLink()) {
    throw new SkillProjectionIntegrityError(
      'symlink_detected',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} root directory was replaced by a symbolic link`,
    );
  }
  if (!stat.isDirectory()) {
    throw new SkillProjectionIntegrityError(
      'root_unsafe',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} root is no longer a directory`,
    );
  }
  let realRoot: string;
  try {
    realRoot = await fs.realpath(skill.rootDir);
  } catch (cause) {
    throw new SkillProjectionIntegrityError(
      'root_unsafe',
      skill.id,
      `failed to resolve pinned skill ${JSON.stringify(skill.id)} root directory`,
      { cause },
    );
  }
  if (realRoot !== skill.rootDir) {
    throw new SkillProjectionIntegrityError(
      'root_unsafe',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} root directory no longer matches its canonical path`,
    );
  }
}

/**
 * Walks a directory/pack skill root to verify that no unexpected files,
 * symlinks, or non-regular entries appeared and no pinned files disappeared.
 */
async function verifyDirectoryTreeMatchesPinned(skill: ResolvedSkillSnapshot): Promise<void> {
  const pinnedPaths = new Set(skill.files.map((file) => file.path));
  const observedPaths = new Set<string>();

  const visit = async (currentDir: string, currentRel: string): Promise<void> => {
    let dirents;
    try {
      dirents = (await fs.readdir(currentDir, { withFileTypes: true })).sort((a, b) => compareCodeUnits(a.name, b.name));
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) {
        throw new SkillProjectionIntegrityError(
          'root_missing',
          skill.id,
          `pinned skill ${JSON.stringify(skill.id)} directory disappeared during verification`,
          { cause, filePath: currentRel || undefined },
        );
      }
      throw new SkillProjectionIntegrityError(
        'root_unsafe',
        skill.id,
        `failed to read pinned skill ${JSON.stringify(skill.id)} directory`,
        { cause, filePath: currentRel || undefined },
      );
    }

    for (const dirent of dirents) {
      const relPosix = currentRel === '' ? dirent.name : `${currentRel}/${dirent.name}`;
      const childAbs = path.join(currentDir, dirent.name);
      let childStat: BigIntStats;
      try {
        childStat = await fs.lstat(childAbs, { bigint: true });
      } catch (cause) {
        if (isErrno(cause, 'ENOENT')) {
          throw new SkillProjectionIntegrityError(
            'file_missing',
            skill.id,
            `pinned skill ${JSON.stringify(skill.id)} entry disappeared: ${JSON.stringify(relPosix)}`,
            { cause, filePath: relPosix },
          );
        }
        throw new SkillProjectionIntegrityError(
          'root_unsafe',
          skill.id,
          `failed to stat pinned skill ${JSON.stringify(skill.id)} entry ${JSON.stringify(relPosix)}`,
          { cause, filePath: relPosix },
        );
      }
      if (dirent.isSymbolicLink() || childStat.isSymbolicLink()) {
        throw new SkillProjectionIntegrityError(
          'symlink_detected',
          skill.id,
          `pinned skill ${JSON.stringify(skill.id)} contains symbolic link ${JSON.stringify(relPosix)}`,
          { filePath: relPosix },
        );
      }
      if (childStat.isDirectory()) {
        if (!isSkillPackPathSafe(relPosix)) {
          throw new SkillProjectionIntegrityError(
            'unexpected_entry',
            skill.id,
            `pinned skill ${JSON.stringify(skill.id)} contains unexpected directory ${JSON.stringify(relPosix)}`,
            { filePath: relPosix },
          );
        }
        if ((await fs.realpath(childAbs)) !== childAbs) {
          throw new SkillProjectionIntegrityError(
            'symlink_detected',
            skill.id,
            `pinned skill ${JSON.stringify(skill.id)} subdirectory ${JSON.stringify(relPosix)} escapes its root`,
            { filePath: relPosix },
          );
        }
        await visit(childAbs, relPosix);
      } else if (childStat.isFile()) {
        if (!pinnedPaths.has(relPosix)) {
          throw new SkillProjectionIntegrityError(
            'unexpected_file',
            skill.id,
            `pinned skill ${JSON.stringify(skill.id)} has unpinned file ${JSON.stringify(relPosix)}`,
            { filePath: relPosix },
          );
        }
        observedPaths.add(relPosix);
      } else {
        throw new SkillProjectionIntegrityError(
          'unexpected_entry',
          skill.id,
          `pinned skill ${JSON.stringify(skill.id)} contains non-regular entry ${JSON.stringify(relPosix)}`,
          { filePath: relPosix },
        );
      }
    }
  };

  await visit(skill.rootDir, '');
  for (const pinned of skill.files) {
    if (!observedPaths.has(pinned.path)) {
      throw new SkillProjectionIntegrityError(
        'file_missing',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} is missing ${JSON.stringify(pinned.path)}`,
        { filePath: pinned.path },
      );
    }
  }
}

async function resolveVerifiedSourcePath(skill: ResolvedSkillSnapshot, relativePath: string): Promise<string> {
  if (!isSkillPackPathSafe(relativePath)) {
    throw new SkillProjectionIntegrityError(
      'path_unsafe',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} carries unsafe relative path ${JSON.stringify(relativePath)}`,
      { filePath: relativePath },
    );
  }
  const segments = relativePath.split('/');
  const leaf = segments.pop()!;
  let current = skill.rootDir;
  for (const part of segments) {
    current = path.join(current, part);
    let stat: BigIntStats;
    try {
      stat = await fs.lstat(current, { bigint: true });
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) {
        throw new SkillProjectionIntegrityError(
          'file_missing',
          skill.id,
          `pinned skill ${JSON.stringify(skill.id)} ancestor directory missing for ${JSON.stringify(relativePath)}`,
          { cause, filePath: relativePath },
        );
      }
      throw new SkillProjectionIntegrityError(
        'root_unsafe',
        skill.id,
        `failed to stat pinned skill ${JSON.stringify(skill.id)} directory for ${JSON.stringify(relativePath)}`,
        { cause, filePath: relativePath },
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.realpath(current)) !== current) {
      throw new SkillProjectionIntegrityError(
        stat.isSymbolicLink() ? 'symlink_detected' : 'root_unsafe',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} intermediate directory is unsafe for ${JSON.stringify(relativePath)}`,
        { filePath: relativePath },
      );
    }
  }
  const target = path.join(current, leaf);
  const expectedPrefix = skill.rootDir.endsWith(path.sep) ? skill.rootDir : `${skill.rootDir}${path.sep}`;
  if (!target.startsWith(expectedPrefix)) {
    throw new SkillProjectionIntegrityError(
      'path_unsafe',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(relativePath)} escapes its root`,
      { filePath: relativePath },
    );
  }
  return target;
}

/**
 * Opens and reads one pinned file via a pathname-bound handle, verifying
 * non-symlink, `nlink === 1`, exact byte length, and exact SHA-256 against the
 * pinned manifest.
 */
async function readVerifiedPinnedFile(
  skill: ResolvedSkillSnapshot,
  pinned: Readonly<PinnedSkillFile>,
): Promise<Buffer> {
  const sourcePath = await resolveVerifiedSourcePath(skill, pinned.path);
  let namedBefore: BigIntStats;
  try {
    namedBefore = await fs.lstat(sourcePath, { bigint: true });
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) {
      throw new SkillProjectionIntegrityError(
        'file_missing',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} is missing ${JSON.stringify(pinned.path)}`,
        { cause, filePath: pinned.path },
      );
    }
    throw new SkillProjectionIntegrityError(
      'root_unsafe',
      skill.id,
      `failed to stat pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)}`,
      { cause, filePath: pinned.path },
    );
  }
  if (namedBefore.isSymbolicLink()) {
    throw new SkillProjectionIntegrityError(
      'symlink_detected',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} was replaced by a symbolic link`,
      { filePath: pinned.path },
    );
  }
  if (!namedBefore.isFile()) {
    throw new SkillProjectionIntegrityError(
      'unexpected_entry',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} is no longer a regular file`,
      { filePath: pinned.path },
    );
  }
  if (namedBefore.nlink !== 1n) {
    throw new SkillProjectionIntegrityError(
      'hardlink_detected',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} is hard-linked (nlink=${namedBefore.nlink})`,
      { filePath: pinned.path },
    );
  }
  if (namedBefore.size !== BigInt(pinned.bytes)) {
    throw new SkillProjectionIntegrityError(
      'file_size_mismatch',
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} expected ${pinned.bytes} bytes, found ${namedBefore.size}`,
      { filePath: pinned.path },
    );
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      sourcePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (cause) {
    if (isErrno(cause, 'ELOOP')) {
      throw new SkillProjectionIntegrityError(
        'symlink_detected',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} is a symbolic link`,
        { cause, filePath: pinned.path },
      );
    }
    if (isErrno(cause, 'ENOENT')) {
      throw new SkillProjectionIntegrityError(
        'file_missing',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} disappeared before open`,
        { cause, filePath: pinned.path },
      );
    }
    throw new SkillProjectionIntegrityError(
      'root_unsafe',
      skill.id,
      `failed to open pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)}`,
      { cause, filePath: pinned.path },
    );
  }

  let bytes: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    const namedAfterOpen = await fs.lstat(sourcePath, { bigint: true });
    if (namedAfterOpen.isSymbolicLink()) {
      throw new SkillProjectionIntegrityError(
        'symlink_detected',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} became a symbolic link`,
        { filePath: pinned.path },
      );
    }
    if (!opened.isFile() || !namedAfterOpen.isFile()) {
      throw new SkillProjectionIntegrityError(
        'unexpected_entry',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} is not a regular file`,
        { filePath: pinned.path },
      );
    }
    if (opened.nlink !== 1n || namedAfterOpen.nlink !== 1n) {
      throw new SkillProjectionIntegrityError(
        'hardlink_detected',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} gained a hard link`,
        { filePath: pinned.path },
      );
    }
    if (!sameContent(namedBefore, opened) || !sameContent(opened, namedAfterOpen)) {
      throw new SkillProjectionIntegrityError(
        'file_changed_during_read',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} changed before read`,
        { filePath: pinned.path },
      );
    }
    if (opened.size !== BigInt(pinned.bytes)) {
      throw new SkillProjectionIntegrityError(
        'file_size_mismatch',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} changed size before read`,
        { filePath: pinned.path },
      );
    }

    const buffer = Buffer.allocUnsafe(pinned.bytes + 1);
    let offset = 0;
    while (offset <= pinned.bytes) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > pinned.bytes) {
        throw new SkillProjectionIntegrityError(
          'file_size_mismatch',
          skill.id,
          `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} grew past ${pinned.bytes} bytes during read`,
          { filePath: pinned.path },
        );
      }
    }
    const afterRead = await handle.stat({ bigint: true });
    const namedAfterRead = await fs.lstat(sourcePath, { bigint: true });
    if (
      offset !== pinned.bytes ||
      namedAfterRead.isSymbolicLink() ||
      !sameContent(opened, afterRead) ||
      !sameContent(afterRead, namedAfterRead)
    ) {
      throw new SkillProjectionIntegrityError(
        'file_changed_during_read',
        skill.id,
        `pinned skill ${JSON.stringify(skill.id)} file ${JSON.stringify(pinned.path)} changed during read`,
        { filePath: pinned.path },
      );
    }
    bytes = buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }

  const observedHash = hashBytes(bytes);
  const check = checkSkillPackFileContent(
    { path: pinned.path, contentHash: pinned.sha256, byteSize: pinned.bytes },
    { byteSize: bytes.byteLength, contentHash: observedHash },
  );
  if (!check.ok) {
    const reason: SkillProjectionIntegrityReason =
      check.reason === 'hash-mismatch'
        ? 'file_hash_mismatch'
        : check.reason === 'size-mismatch' || check.reason === 'file-over-cap'
          ? 'file_size_mismatch'
          : 'path_unsafe';
    throw new SkillProjectionIntegrityError(
      reason,
      skill.id,
      `pinned skill ${JSON.stringify(skill.id)} failed integrity check at ${JSON.stringify(pinned.path)}: ${check.reason} — ${check.detail}`,
      { filePath: pinned.path },
    );
  }

  return bytes;
}

/**
 * Copies bytes (never symlinks) for each resolved skill into
 * `<targetRootDir>/<index>-<id>/` (`0700` dirs, `0600` files, atomic write),
 * re-verifying every pinned file against its snapshot before writing.
 *
 * `{ pack }` sources hold `acquirePathMutationGate({ scope: 'skill-pack-store' })`
 * across verification and reads so concurrent pack installs or retention sweeps
 * cannot race the pinned revision directory.
 */
export async function projectResolvedSkills(
  skills: readonly ResolvedSkillSnapshot[],
  targetRootDir: string,
): Promise<readonly ProjectedSkill[]> {
  if (typeof targetRootDir !== 'string' || targetRootDir.trim().length === 0 || !path.isAbsolute(targetRootDir) || /[\u0000\r\n]/u.test(targetRootDir)) {
    throw new SkillProjectionIntegrityError(
      'target_unsafe',
      skills[0]?.id ?? '<none>',
      'projection targetRootDir must be a non-empty single-line absolute path',
    );
  }
  if (skills.length === 0) return Object.freeze([]);

  const packStoreRoots = [
    ...new Set(
      skills
        .filter((skill) => skill.sourceKind === 'pack')
        .map((skill) => skill.packStoreRoot ?? path.dirname(path.dirname(skill.rootDir))),
    ),
  ];

  const gates: readonly PathMutationGate[] = packStoreRoots.length === 0
    ? []
    : await acquirePathMutationGates(
        packStoreRoots.map((targetPath) => ({ scope: 'skill-pack-store' as const, targetPath })),
        { waitMs: PACK_STORE_GATE_WAIT_MS },
      );

  const createdSkillDirs: string[] = [];
  let operationError: unknown;
  let hasOperationError = false;
  try {
    const canonicalTargetRoot = await checkedTargetDirectory(targetRootDir, '', skills[0]!.id);
    const projected: ProjectedSkill[] = [];

    for (const [index, skill] of skills.entries()) {
      await assertSourceRootCanonical(skill);
      if (skill.sourceKind !== 'file') {
        await verifyDirectoryTreeMatchesPinned(skill);
      }

      const verifiedFiles = new Map<string, Buffer>();
      for (const pinned of skill.files) {
        verifiedFiles.set(pinned.path, await readVerifiedPinnedFile(skill, pinned));
      }

      const segment = `${index}-${skill.id}`;
      if (!SKILL_PACK_FILE_PATH_PATTERN.test(segment)) {
        throw new SkillProjectionIntegrityError(
          'path_unsafe',
          skill.id,
          `projected directory segment ${JSON.stringify(segment)} is unsafe`,
        );
      }
      const skillTargetDir = path.join(canonicalTargetRoot, segment);
      try {
        await fs.mkdir(skillTargetDir, { mode: DIR_MODE });
      } catch (cause) {
        throw new SkillProjectionIntegrityError(
          'target_unsafe',
          skill.id,
          `projection target directory ${skillTargetDir} already exists or cannot be created`,
          { cause },
        );
      }
      createdSkillDirs.push(skillTargetDir);
      if (process.platform !== 'win32') {
        await fs.chmod(skillTargetDir, DIR_MODE);
      }
      if ((await fs.realpath(skillTargetDir)) !== skillTargetDir) {
        throw new SkillProjectionIntegrityError(
          'target_unsafe',
          skill.id,
          `projection target directory ${skillTargetDir} resolves outside ${canonicalTargetRoot}`,
        );
      }

      for (const [relPath, bytes] of verifiedFiles) {
        const parts = relPath.split('/');
        const leaf = parts.pop()!;
        const destDir = parts.length === 0
          ? skillTargetDir
          : await checkedTargetDirectory(skillTargetDir, parts.join('/'), skill.id);
        const destPath = path.join(destDir, leaf);
        const existingLeaf = await fs.lstat(destPath).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return undefined;
          throw new SkillProjectionIntegrityError(
            'target_unsafe',
            skill.id,
            `failed to stat projection destination ${destPath}`,
            { cause: err, filePath: relPath },
          );
        });
        if (existingLeaf?.isSymbolicLink()) {
          throw new SkillProjectionIntegrityError(
            'target_unsafe',
            skill.id,
            `projection destination ${destPath} is a symbolic link`,
            { filePath: relPath },
          );
        }
        await atomicWriteFile(destPath, bytes, { mode: FILE_MODE });
      }

      projected.push(
        Object.freeze({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          dir: skillTargetDir,
        }),
      );
    }

    return Object.freeze(projected);
  } catch (error) {
    hasOperationError = true;
    operationError = error;
    await Promise.allSettled(createdSkillDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    throw error;
  } finally {
    const releaseFailures: unknown[] = [];
    for (const gate of [...gates].reverse()) {
      try {
        await gate.release();
      } catch (releaseError) {
        releaseFailures.push(releaseError);
      }
    }
    if (releaseFailures.length > 0) {
      if (hasOperationError) {
        throw withGateReleaseFailures(operationError, releaseFailures);
      }
      throw withGateReleaseFailures(releaseFailures[0], releaseFailures.slice(1));
    }
  }
}
