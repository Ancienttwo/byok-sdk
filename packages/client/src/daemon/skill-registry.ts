import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import path from 'node:path';
import {
  CONTENT_HASH_PATTERN,
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_FILE_MAX_BYTES,
  SKILL_PACK_FORBIDDEN_FIELDS,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  SKILL_PACK_MAX_BYTES,
  checkSkillPackEntry,
  checkSkillPackFileContent,
  checkSkillPackManifest,
  contentHash,
  isSkillPackPathSafe,
  parseSkillFrontmatter,
  parseSkillPackManifest,
  skillPackContentHashInput,
  type ContentHash,
  type SkillPackManifest,
} from '@byok-sdk/core';
import {
  CONFIGURED_SKILLS_MAX_ITEMS,
  SkillIdSchema,
  type SkillId,
} from '@byok-sdk/protocol';
import type {
  SkillEntryStatus,
  SkillRegistryStatus,
  SkillReloadReceipt,
  SkillSource,
} from '../types.js';
import { compareCodeUnits } from '../util/compare-code-units.js';
import { sameContent } from '../util/file-state.js';
import {
  SKILL_PACKS_DIRNAME,
  SKILL_PACK_LOCK_FILENAME,
  SKILL_PACK_LOCK_SCHEMA,
  SKILL_PACK_RESPONSE_MAX_BYTES,
} from './skill-pack-installer.js';

const MAX_SKILL_PATH_BYTES = 4096;
const C0_CONTROL_PATTERN = /[\u0000-\u001f]/u;
const SKILL_PACK_MAX_FILES = 64;
const SKILL_PACK_NAME_MAX_LENGTH = 64;
const SKILL_PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

type SkillFrontmatter = ReturnType<typeof parseSkillFrontmatter>;

export const SKILL_REGISTRY_ERROR_CODES = [
  'invalid_config',
  'invalid_skill_id',
  'invalid_revision',
  'path_not_absolute',
  'path_not_found',
  'path_unsafe',
  'symlink_forbidden',
  'hardlink_forbidden',
  'unsupported_file_type',
  'entry_missing',
  'frontmatter_invalid',
  'file_count_over_cap',
  'file_over_cap',
  'pack_over_cap',
  'pack_not_installed',
  'pack_corrupt',
  'io_error',
] as const;

export type SkillRegistryErrorCode = (typeof SKILL_REGISTRY_ERROR_CODES)[number];

/** Typed refusal for invalid skill configuration, content, or store state. */
export class SkillRegistryError extends Error {
  readonly code: SkillRegistryErrorCode;
  readonly skillId: string | undefined;

  constructor(
    code: SkillRegistryErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly skillId?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SkillRegistryError';
    this.code = code;
    this.skillId = options.skillId;
  }
}

/** Optimistic CAS refusal when `expectedRevision` no longer matches the live snapshot. */
export class SkillRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(`skill registry revision conflict: expected ${expectedRevision}, current ${actualRevision}`);
    this.name = 'SkillRevisionConflictError';
  }
}

export type SkillConfigInput = Record<string, SkillSource> | undefined;

export interface SkillRegistryOptions {
  /** Daemon store directory holding `<dataDir>/skill-packs/` for `{ pack }` sources. */
  readonly dataDir?: string;
}

export interface PinnedSkillFile {
  readonly path: string;
  readonly sha256: ContentHash;
  readonly bytes: number;
}

export interface ResolvedSkillSnapshot {
  readonly id: SkillId;
  readonly source: SkillSource;
  readonly sourceKind: 'file' | 'directory' | 'pack';
  readonly name: string;
  readonly description: string;
  readonly rootDir: string;
  /** Canonical `<dataDir>/skill-packs` directory for `{ pack }` sources, used to lock store reads during projection. */
  readonly packStoreRoot?: string;
  readonly packVersion?: string;
  readonly files: readonly Readonly<PinnedSkillFile>[];
  readonly contentHash: ContentHash;
}

export interface SkillRegistrySnapshot {
  readonly revision: string;
  readonly skills: ReadonlyMap<SkillId, ResolvedSkillSnapshot>;
  readonly configuredSkills: readonly SkillId[];
}

interface ResolvedPackData {
  readonly name: string;
  readonly description: string;
  readonly rootDir: string;
  readonly packStoreRoot: string;
  readonly packVersion: string;
  readonly files: readonly Readonly<PinnedSkillFile>[];
  readonly contentHash: ContentHash;
}

function hashBytes(bytes: Uint8Array): ContentHash {
  return contentHash(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function validateSkillSource(skillId: SkillId, raw: unknown): SkillSource {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillRegistryError('invalid_config', `DaemonConfig.skills.${skillId} must be an object`, { skillId });
  }
  const record = raw as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_PROTOTYPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, forbidden)) {
      throw new SkillRegistryError(
        'invalid_config',
        `DaemonConfig.skills.${skillId} must not declare prototype key ${JSON.stringify(forbidden)}`,
        { skillId },
      );
    }
  }
  const keys = Object.keys(record);
  if (keys.length !== 1 || (keys[0] !== 'path' && keys[0] !== 'pack')) {
    throw new SkillRegistryError(
      'invalid_config',
      `DaemonConfig.skills.${skillId} must specify exactly one of { path } or { pack }`,
      { skillId },
    );
  }
  if (keys[0] === 'path') {
    const rawPath = record.path;
    if (typeof rawPath !== 'string') {
      throw new SkillRegistryError(
        'path_not_absolute',
        `DaemonConfig.skills.${skillId}.path must be a non-empty absolute path`,
        { skillId },
      );
    }
    if (C0_CONTROL_PATTERN.test(rawPath)) {
      throw new SkillRegistryError(
        'path_unsafe',
        `DaemonConfig.skills.${skillId}.path must not contain C0 control characters`,
        { skillId },
      );
    }
    if (Buffer.byteLength(rawPath, 'utf8') > MAX_SKILL_PATH_BYTES) {
      throw new SkillRegistryError(
        'path_unsafe',
        `DaemonConfig.skills.${skillId}.path must not exceed ${MAX_SKILL_PATH_BYTES} UTF-8 bytes`,
        { skillId },
      );
    }
    if (rawPath.trim().length === 0 || !path.isAbsolute(rawPath)) {
      throw new SkillRegistryError(
        'path_not_absolute',
        `DaemonConfig.skills.${skillId}.path must be a non-empty absolute path`,
        { skillId },
      );
    }
    return Object.freeze({ path: rawPath });
  }
  const rawPack = record.pack;
  if (
    typeof rawPack !== 'string' ||
    rawPack.length === 0 ||
    rawPack.length > SKILL_PACK_NAME_MAX_LENGTH ||
    !SKILL_PACK_NAME_PATTERN.test(rawPack) ||
    !isSkillPackPathSafe(rawPack) ||
    FORBIDDEN_PROTOTYPE_KEYS.has(rawPack)
  ) {
    throw new SkillRegistryError(
      'invalid_config',
      `DaemonConfig.skills.${skillId}.pack must be a valid skill pack name`,
      { skillId },
    );
  }
  return Object.freeze({ pack: rawPack });
}

/**
 * Reads one regular file synchronously without following symlinks, rejecting
 * hard links (`nlink !== 1`), non-regular files, files above `maxBytes`, and
 * concurrent pathname/content swaps during the read.
 */
function readPinnedRegularFileSync(
  absPath: string,
  maxBytes: number,
  skillId: SkillId,
  missingCode: 'path_not_found' | 'pack_not_installed' | 'pack_corrupt',
): Buffer {
  let before: BigIntStats;
  try {
    before = lstatSync(absPath, { bigint: true });
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) {
      throw new SkillRegistryError(missingCode, `skill ${JSON.stringify(skillId)} file not found: ${absPath}`, {
        skillId,
        cause,
      });
    }
    throw new SkillRegistryError('io_error', `failed to stat skill ${JSON.stringify(skillId)} file ${absPath}`, {
      skillId,
      cause,
    });
  }
  if (before.isSymbolicLink()) {
    throw new SkillRegistryError('symlink_forbidden', `skill ${JSON.stringify(skillId)} refuses symbolic link ${absPath}`, {
      skillId,
    });
  }
  if (!before.isFile()) {
    throw new SkillRegistryError(
      'unsupported_file_type',
      `skill ${JSON.stringify(skillId)} path is not a regular file: ${absPath}`,
      { skillId },
    );
  }
  if (before.nlink !== 1n) {
    throw new SkillRegistryError(
      'hardlink_forbidden',
      `skill ${JSON.stringify(skillId)} refuses hard-linked file (nlink=${before.nlink}): ${absPath}`,
      { skillId },
    );
  }
  if (before.size < 0n || before.size > BigInt(maxBytes)) {
    throw new SkillRegistryError(
      'file_over_cap',
      `skill ${JSON.stringify(skillId)} file ${absPath} is ${before.size} bytes, over the ${maxBytes} byte limit`,
      { skillId },
    );
  }

  let fd: number;
  try {
    fd = openSync(absPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (cause) {
    if (isErrno(cause, 'ELOOP')) {
      throw new SkillRegistryError('symlink_forbidden', `skill ${JSON.stringify(skillId)} refuses symbolic link ${absPath}`, {
        skillId,
        cause,
      });
    }
    if (isErrno(cause, 'ENOENT')) {
      throw new SkillRegistryError(missingCode, `skill ${JSON.stringify(skillId)} file disappeared: ${absPath}`, {
        skillId,
        cause,
      });
    }
    throw new SkillRegistryError('io_error', `failed to open skill ${JSON.stringify(skillId)} file ${absPath}`, {
      skillId,
      cause,
    });
  }

  try {
    const opened = fstatSync(fd, { bigint: true });
    const afterOpen = lstatSync(absPath, { bigint: true });
    if (afterOpen.isSymbolicLink()) {
      throw new SkillRegistryError('symlink_forbidden', `skill ${JSON.stringify(skillId)} refuses symbolic link ${absPath}`, {
        skillId,
      });
    }
    if (!opened.isFile() || !afterOpen.isFile()) {
      throw new SkillRegistryError(
        'unsupported_file_type',
        `skill ${JSON.stringify(skillId)} path changed to a non-regular file: ${absPath}`,
        { skillId },
      );
    }
    if (opened.nlink !== 1n || afterOpen.nlink !== 1n) {
      throw new SkillRegistryError(
        'hardlink_forbidden',
        `skill ${JSON.stringify(skillId)} refuses hard-linked file: ${absPath}`,
        { skillId },
      );
    }
    if (!sameContent(before, opened) || !sameContent(opened, afterOpen)) {
      throw new SkillRegistryError('io_error', `skill ${JSON.stringify(skillId)} file changed before read: ${absPath}`, {
        skillId,
      });
    }
    if (opened.size < 0n || opened.size > BigInt(maxBytes)) {
      throw new SkillRegistryError(
        'file_over_cap',
        `skill ${JSON.stringify(skillId)} file ${absPath} exceeds the ${maxBytes} byte limit`,
        { skillId },
      );
    }

    const expectedSize = Number(opened.size);
    const buffer = Buffer.allocUnsafe(expectedSize + 1);
    let offset = 0;
    while (offset <= expectedSize) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
      if (offset > expectedSize || offset > maxBytes) {
        throw new SkillRegistryError(
          offset > maxBytes ? 'file_over_cap' : 'io_error',
          `skill ${JSON.stringify(skillId)} file grew during read: ${absPath}`,
          { skillId },
        );
      }
    }
    const afterRead = fstatSync(fd, { bigint: true });
    const namedAfterRead = lstatSync(absPath, { bigint: true });
    if (
      offset !== expectedSize ||
      namedAfterRead.isSymbolicLink() ||
      !sameContent(opened, afterRead) ||
      !sameContent(afterRead, namedAfterRead)
    ) {
      throw new SkillRegistryError('io_error', `skill ${JSON.stringify(skillId)} file changed during read: ${absPath}`, {
        skillId,
      });
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof SkillRegistryError) throw error;
    throw new SkillRegistryError('io_error', `failed to read skill ${JSON.stringify(skillId)} file ${absPath}`, {
      skillId,
      cause: error,
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * Checks a directory chain below a host-selected root synchronously.
 * Ancestors above `root` may have platform aliases (e.g. macOS `/var`), while
 * `root` itself and every segment under `relative` must be real non-symlink
 * directories whose native realpaths stay pinned in place.
 */
function checkedDirectorySync(
  root: string,
  relative: string,
  skillId: SkillId,
  missingCode: 'path_not_found' | 'pack_not_installed' | 'pack_corrupt',
  notDirCode: 'unsupported_file_type' | 'pack_corrupt',
): string {
  const absoluteRoot = path.resolve(root);
  const requireDir = (directory: string): void => {
    let stats: BigIntStats;
    try {
      stats = lstatSync(directory, { bigint: true });
    } catch (cause) {
      if (isErrno(cause, 'ENOENT')) {
        throw new SkillRegistryError(missingCode, `skill ${JSON.stringify(skillId)} directory not found: ${directory}`, {
          skillId,
          cause,
        });
      }
      if (isErrno(cause, 'ENOTDIR')) {
        throw new SkillRegistryError(notDirCode, `skill ${JSON.stringify(skillId)} has a non-directory ancestor: ${directory}`, {
          skillId,
          cause,
        });
      }
      throw new SkillRegistryError('io_error', `failed to stat skill ${JSON.stringify(skillId)} directory ${directory}`, {
        skillId,
        cause,
      });
    }
    if (stats.isSymbolicLink()) {
      throw new SkillRegistryError('symlink_forbidden', `skill ${JSON.stringify(skillId)} refuses symbolic link ${directory}`, {
        skillId,
      });
    }
    if (!stats.isDirectory()) {
      throw new SkillRegistryError(notDirCode, `skill ${JSON.stringify(skillId)} expected a directory at ${directory}`, {
        skillId,
      });
    }
  };

  requireDir(absoluteRoot);
  const canonicalRoot = realpathSync.native(absoluteRoot);
  let directory = canonicalRoot;
  for (const part of relative === '' ? [] : relative.split('/')) {
    directory = path.join(directory, part);
    requireDir(directory);
    if (realpathSync.native(directory) !== directory) {
      throw new SkillRegistryError(
        'symlink_forbidden',
        `skill ${JSON.stringify(skillId)} directory ${directory} resolves outside its checked chain`,
        { skillId },
      );
    }
  }
  return directory;
}

function parseEntryFrontmatter(entryBytes: Uint8Array, skillId: SkillId): { readonly text: string; readonly frontmatter: SkillFrontmatter } {
  let text: string;
  try {
    text = UTF8_DECODER.decode(entryBytes);
  } catch (cause) {
    throw new SkillRegistryError(
      'frontmatter_invalid',
      `skill ${JSON.stringify(skillId)} ${SKILL_PACK_ENTRY_PATH} is not valid UTF-8`,
      { skillId, cause },
    );
  }
  try {
    return { text, frontmatter: parseSkillFrontmatter(text) };
  } catch (cause) {
    throw new SkillRegistryError(
      'frontmatter_invalid',
      `skill ${JSON.stringify(skillId)} ${SKILL_PACK_ENTRY_PATH} frontmatter rejected: ${cause instanceof Error ? cause.message : String(cause)}`,
      { skillId, cause },
    );
  }
}

interface WalkedDirectory {
  readonly files: readonly Readonly<PinnedSkillFile>[];
  readonly entryBytes: Buffer;
}

function walkSkillDirectorySync(
  canonicalRootDir: string,
  skillId: SkillId,
  missingCode: 'path_not_found' | 'pack_corrupt',
): WalkedDirectory {
  const files: Readonly<PinnedSkillFile>[] = [];
  let totalBytes = 0;
  let entryBytes: Buffer | undefined;

  const visit = (currentDir: string, currentRel: string): void => {
    let dirents;
    try {
      dirents = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name));
    } catch (cause) {
      throw new SkillRegistryError('io_error', `failed to read skill ${JSON.stringify(skillId)} directory ${currentDir}`, {
        skillId,
        cause,
      });
    }
    for (const dirent of dirents) {
      const relPosix = currentRel === '' ? dirent.name : `${currentRel}/${dirent.name}`;
      const childAbs = path.join(currentDir, dirent.name);
      let childStat: BigIntStats;
      try {
        childStat = lstatSync(childAbs, { bigint: true });
      } catch (cause) {
        if (isErrno(cause, 'ENOENT')) {
          throw new SkillRegistryError(missingCode, `skill ${JSON.stringify(skillId)} entry disappeared: ${relPosix}`, {
            skillId,
            cause,
          });
        }
        throw new SkillRegistryError('io_error', `failed to stat skill ${JSON.stringify(skillId)} entry ${relPosix}`, {
          skillId,
          cause,
        });
      }
      if (dirent.isSymbolicLink() || childStat.isSymbolicLink()) {
        throw new SkillRegistryError(
          'symlink_forbidden',
          `skill ${JSON.stringify(skillId)} refuses symbolic link ${JSON.stringify(relPosix)}`,
          { skillId },
        );
      }
      if (!isSkillPackPathSafe(relPosix)) {
        throw new SkillRegistryError(
          'path_unsafe',
          `skill ${JSON.stringify(skillId)} contains unsafe relative path ${JSON.stringify(relPosix)}`,
          { skillId },
        );
      }
      if (childStat.isDirectory()) {
        if (realpathSync.native(childAbs) !== childAbs) {
          throw new SkillRegistryError(
            'symlink_forbidden',
            `skill ${JSON.stringify(skillId)} subdirectory ${JSON.stringify(relPosix)} escapes its root`,
            { skillId },
          );
        }
        visit(childAbs, relPosix);
      } else if (childStat.isFile()) {
        if (files.length >= SKILL_PACK_MAX_FILES) {
          throw new SkillRegistryError(
            'file_count_over_cap',
            `skill ${JSON.stringify(skillId)} exceeds the ${SKILL_PACK_MAX_FILES} file limit`,
            { skillId },
          );
        }
        const bytes = readPinnedRegularFileSync(childAbs, SKILL_PACK_FILE_MAX_BYTES, skillId, missingCode);
        totalBytes += bytes.byteLength;
        if (totalBytes > SKILL_PACK_MAX_BYTES) {
          throw new SkillRegistryError(
            'pack_over_cap',
            `skill ${JSON.stringify(skillId)} exceeds the ${SKILL_PACK_MAX_BYTES} byte total limit`,
            { skillId },
          );
        }
        const fileHash = hashBytes(bytes);
        const contentCheck = checkSkillPackFileContent(
          { path: relPosix, contentHash: fileHash, byteSize: bytes.byteLength },
          { byteSize: bytes.byteLength, contentHash: fileHash },
        );
        if (!contentCheck.ok) {
          throw new SkillRegistryError(
            contentCheck.reason === 'file-over-cap' ? 'file_over_cap' : 'path_unsafe',
            `skill ${JSON.stringify(skillId)}: ${contentCheck.reason} — ${contentCheck.detail}`,
            { skillId },
          );
        }
        if (relPosix === SKILL_PACK_ENTRY_PATH) entryBytes = bytes;
        files.push(Object.freeze({ path: relPosix, sha256: fileHash, bytes: bytes.byteLength }));
      } else {
        throw new SkillRegistryError(
          'unsupported_file_type',
          `skill ${JSON.stringify(skillId)} contains non-regular entry ${JSON.stringify(relPosix)}`,
          { skillId },
        );
      }
    }
  };

  visit(canonicalRootDir, '');
  if (entryBytes === undefined) {
    throw new SkillRegistryError(
      'entry_missing',
      `skill ${JSON.stringify(skillId)} is missing required ${SKILL_PACK_ENTRY_PATH}`,
      { skillId },
    );
  }
  files.sort((left, right) => compareCodeUnits(left.path, right.path));
  return { files: Object.freeze(files), entryBytes };
}

function resolvePathSkillSync(skillId: SkillId, source: { readonly path: string }): ResolvedSkillSnapshot {
  // Resolve removes trailing separators so POSIX lstat does not dereference a symlinked directory path ending in "/".
  const configuredPath = path.resolve(source.path);
  let rootStat: BigIntStats;
  try {
    rootStat = lstatSync(configuredPath, { bigint: true });
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) {
      throw new SkillRegistryError(
        'path_not_found',
        `skill ${JSON.stringify(skillId)} path does not exist: ${configuredPath}`,
        { skillId, cause },
      );
    }
    throw new SkillRegistryError('io_error', `failed to stat skill ${JSON.stringify(skillId)} path ${configuredPath}`, {
      skillId,
      cause,
    });
  }
  if (rootStat.isSymbolicLink()) {
    throw new SkillRegistryError(
      'symlink_forbidden',
      `skill ${JSON.stringify(skillId)} configured path must not be a symbolic link: ${configuredPath}`,
      { skillId },
    );
  }

  if (rootStat.isFile()) {
    if (path.basename(configuredPath) !== SKILL_PACK_ENTRY_PATH) {
      throw new SkillRegistryError(
        'path_unsafe',
        `skill ${JSON.stringify(skillId)} single-file path must point to ${SKILL_PACK_ENTRY_PATH}`,
        { skillId },
      );
    }
    const canonicalFile = realpathSync.native(configuredPath);
    const rootDir = path.dirname(canonicalFile);
    const entryBytes = readPinnedRegularFileSync(canonicalFile, SKILL_PACK_FILE_MAX_BYTES, skillId, 'path_not_found');
    const fileHash = hashBytes(entryBytes);
    const contentCheck = checkSkillPackFileContent(
      { path: SKILL_PACK_ENTRY_PATH, contentHash: fileHash, byteSize: entryBytes.byteLength },
      { byteSize: entryBytes.byteLength, contentHash: fileHash },
    );
    if (!contentCheck.ok) {
      throw new SkillRegistryError(
        contentCheck.reason === 'file-over-cap' ? 'file_over_cap' : 'path_unsafe',
        `skill ${JSON.stringify(skillId)}: ${contentCheck.reason} — ${contentCheck.detail}`,
        { skillId },
      );
    }
    const { frontmatter } = parseEntryFrontmatter(entryBytes, skillId);
    const pinnedFile: Readonly<PinnedSkillFile> = Object.freeze({
      path: SKILL_PACK_ENTRY_PATH,
      sha256: fileHash,
      bytes: entryBytes.byteLength,
    });
    const aggregateHash = hashBytes(
      Buffer.from(
        skillPackContentHashInput({
          name: frontmatter.name,
          version: '0.0.0',
          description: frontmatter.description,
          files: [{ path: pinnedFile.path, contentHash: pinnedFile.sha256, byteSize: pinnedFile.bytes }],
        }),
        'utf8',
      ),
    );
    return Object.freeze({
      id: skillId,
      source,
      sourceKind: 'file' as const,
      name: frontmatter.name,
      description: frontmatter.description,
      rootDir,
      files: Object.freeze([pinnedFile]),
      contentHash: aggregateHash,
    });
  }

  if (!rootStat.isDirectory()) {
    throw new SkillRegistryError(
      'unsupported_file_type',
      `skill ${JSON.stringify(skillId)} path must be a ${SKILL_PACK_ENTRY_PATH} file or directory`,
      { skillId },
    );
  }

  const rootDir = realpathSync.native(configuredPath);
  const { files, entryBytes } = walkSkillDirectorySync(rootDir, skillId, 'path_not_found');
  const { frontmatter } = parseEntryFrontmatter(entryBytes, skillId);
  const aggregateHash = hashBytes(
    Buffer.from(
      skillPackContentHashInput({
        name: frontmatter.name,
        version: '0.0.0',
        description: frontmatter.description,
        files: files.map((file) => ({ path: file.path, contentHash: file.sha256, byteSize: file.bytes })),
      }),
      'utf8',
    ),
  );
  return Object.freeze({
    id: skillId,
    source,
    sourceKind: 'directory' as const,
    name: frontmatter.name,
    description: frontmatter.description,
    rootDir,
    files,
    contentHash: aggregateHash,
  });
}

function parsePackLockToManifest(rawLock: unknown, packName: string, skillId: SkillId): SkillPackManifest {
  if (rawLock === null || typeof rawLock !== 'object' || Array.isArray(rawLock)) {
    throw new SkillRegistryError('pack_corrupt', `installed skill pack ${JSON.stringify(packName)} lock is not an object`, {
      skillId,
    });
  }
  const lock = rawLock as Record<string, unknown>;
  for (const field of SKILL_PACK_FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(lock, field)) {
      throw new SkillRegistryError(
        'pack_corrupt',
        `installed skill pack ${JSON.stringify(packName)} lock carries forbidden field ${JSON.stringify(field)}`,
        { skillId },
      );
    }
  }
  if (
    lock.schema !== SKILL_PACK_LOCK_SCHEMA ||
    lock.name !== packName ||
    typeof lock.version !== 'string' ||
    typeof lock.description !== 'string' ||
    typeof lock.content_hash !== 'string' ||
    !CONTENT_HASH_PATTERN.test(lock.content_hash) ||
    !Array.isArray(lock.files)
  ) {
    throw new SkillRegistryError('pack_corrupt', `installed skill pack ${JSON.stringify(packName)} lock.json is malformed`, {
      skillId,
    });
  }

  const candidateFiles = lock.files.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SkillRegistryError('pack_corrupt', `installed skill pack ${JSON.stringify(packName)} lock file row is invalid`, {
        skillId,
      });
    }
    const row = entry as Record<string, unknown>;
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== 3 || !Object.prototype.hasOwnProperty.call(row, 'path') || !Object.prototype.hasOwnProperty.call(row, 'sha256') || !Object.prototype.hasOwnProperty.call(row, 'bytes')) {
      throw new SkillRegistryError('pack_corrupt', `installed skill pack ${JSON.stringify(packName)} lock file row has unexpected keys`, {
        skillId,
      });
    }
    return { path: row.path, contentHash: row.sha256, byteSize: row.bytes };
  });

  let manifest: SkillPackManifest;
  try {
    manifest = parseSkillPackManifest({
      schema: SKILL_PACK_MANIFEST_SCHEMA_ID,
      name: lock.name,
      version: lock.version,
      description: lock.description,
      files: candidateFiles,
      contentHash: lock.content_hash,
    });
  } catch (cause) {
    throw new SkillRegistryError(
      'pack_corrupt',
      `installed skill pack ${JSON.stringify(packName)} lock manifest is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      { skillId, cause },
    );
  }
  const structural = checkSkillPackManifest(manifest);
  if (!structural.ok) {
    throw new SkillRegistryError(
      'pack_corrupt',
      `installed skill pack ${JSON.stringify(packName)} lock failed manifest check: ${structural.reason} — ${structural.detail}`,
      { skillId },
    );
  }
  const expectedPackHash = hashBytes(Buffer.from(skillPackContentHashInput(manifest), 'utf8'));
  if ((expectedPackHash as string) !== (manifest.contentHash as string)) {
    throw new SkillRegistryError(
      'pack_corrupt',
      `installed skill pack ${JSON.stringify(packName)} content hash disagrees with its lock file rows`,
      { skillId },
    );
  }
  return manifest;
}

function resolvePackSkillSync(
  skillId: SkillId,
  source: { readonly pack: string },
  dataDir: string | undefined,
  packCache: Map<string, ResolvedPackData>,
): ResolvedSkillSnapshot {
  const packName = source.pack;
  let resolved = packCache.get(packName);
  if (resolved === undefined) {
    if (dataDir === undefined || !path.isAbsolute(dataDir)) {
      throw new SkillRegistryError(
        'pack_not_installed',
        `skill ${JSON.stringify(skillId)} references pack ${JSON.stringify(packName)}, but no skill pack store dataDir is configured`,
        { skillId },
      );
    }
    const packStoreRoot = checkedDirectorySync(dataDir, SKILL_PACKS_DIRNAME, skillId, 'pack_not_installed', 'pack_corrupt');
    const packDir = checkedDirectorySync(
      dataDir,
      `${SKILL_PACKS_DIRNAME}/${packName}`,
      skillId,
      'pack_not_installed',
      'pack_corrupt',
    );
    const lockPath = path.join(packDir, SKILL_PACK_LOCK_FILENAME);
    const lockBytes = readPinnedRegularFileSync(lockPath, SKILL_PACK_RESPONSE_MAX_BYTES, skillId, 'pack_not_installed');
    let parsedLock: unknown;
    try {
      parsedLock = JSON.parse(UTF8_DECODER.decode(lockBytes));
    } catch (cause) {
      throw new SkillRegistryError('pack_corrupt', `installed skill pack ${JSON.stringify(packName)} lock.json is not valid JSON`, {
        skillId,
        cause,
      });
    }
    const manifest = parsePackLockToManifest(parsedLock, packName, skillId);
    const revisionHex = (manifest.contentHash as string).slice('sha256:'.length);
    const revisionDir = checkedDirectorySync(
      dataDir,
      `${SKILL_PACKS_DIRNAME}/${packName}/${revisionHex}`,
      skillId,
      'pack_corrupt',
      'pack_corrupt',
    );

    const { files, entryBytes } = walkSkillDirectorySync(revisionDir, skillId, 'pack_corrupt');
    const declaredByPath = new Map(manifest.files.map((file) => [file.path, file]));
    if (files.length !== declaredByPath.size) {
      throw new SkillRegistryError(
        'pack_corrupt',
        `installed skill pack ${JSON.stringify(packName)} revision directory drifted from lock.json file list`,
        { skillId },
      );
    }
    for (const observed of files) {
      const declared = declaredByPath.get(observed.path);
      if (declared === undefined) {
        throw new SkillRegistryError(
          'pack_corrupt',
          `installed skill pack ${JSON.stringify(packName)} contains unexpected file ${JSON.stringify(observed.path)}`,
          { skillId },
        );
      }
      const check = checkSkillPackFileContent(declared, {
        byteSize: observed.bytes,
        contentHash: observed.sha256,
      });
      if (!check.ok) {
        throw new SkillRegistryError(
          'pack_corrupt',
          `installed skill pack ${JSON.stringify(packName)} failed verification at ${JSON.stringify(observed.path)}: ${check.reason} — ${check.detail}`,
          { skillId },
        );
      }
    }

    const { text: entryText, frontmatter } = parseEntryFrontmatter(entryBytes, skillId);
    let entryCheck;
    try {
      entryCheck = checkSkillPackEntry(manifest, entryText);
    } catch (cause) {
      throw new SkillRegistryError(
        'frontmatter_invalid',
        `installed skill pack ${JSON.stringify(packName)} ${SKILL_PACK_ENTRY_PATH} frontmatter rejected: ${cause instanceof Error ? cause.message : String(cause)}`,
        { skillId, cause },
      );
    }
    if (!entryCheck.ok) {
      throw new SkillRegistryError(
        'frontmatter_invalid',
        `installed skill pack ${JSON.stringify(packName)} ${SKILL_PACK_ENTRY_PATH} rejected: ${entryCheck.reason} — ${entryCheck.detail}`,
        { skillId },
      );
    }

    resolved = {
      name: frontmatter.name,
      description: frontmatter.description,
      rootDir: revisionDir,
      packStoreRoot,
      packVersion: manifest.version,
      files,
      contentHash: manifest.contentHash,
    };
    packCache.set(packName, resolved);
  }

  return Object.freeze({
    id: skillId,
    source,
    sourceKind: 'pack' as const,
    name: resolved.name,
    description: resolved.description,
    rootDir: resolved.rootDir,
    packStoreRoot: resolved.packStoreRoot,
    packVersion: resolved.packVersion,
    files: resolved.files,
    contentHash: resolved.contentHash,
  });
}

function buildSnapshot(configured: SkillConfigInput, dataDir: string | undefined): SkillRegistrySnapshot {
  if (configured !== undefined && (configured === null || typeof configured !== 'object' || Array.isArray(configured))) {
    throw new SkillRegistryError('invalid_config', 'DaemonConfig.skills must be an object keyed by logical skill id');
  }
  const sourceRecord = (configured ?? {}) as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_PROTOTYPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sourceRecord, forbidden)) {
      throw new SkillRegistryError(
        'invalid_skill_id',
        `DaemonConfig.skills must not use prototype key ${JSON.stringify(forbidden)}`,
        { skillId: forbidden },
      );
    }
  }
  const entries = Object.entries(sourceRecord).sort(([left], [right]) => compareCodeUnits(left, right));
  if (entries.length > CONFIGURED_SKILLS_MAX_ITEMS) {
    throw new SkillRegistryError(
      'invalid_config',
      `DaemonConfig.skills may contain at most ${CONFIGURED_SKILLS_MAX_ITEMS} skills`,
    );
  }

  const resolved = new Map<SkillId, ResolvedSkillSnapshot>();
  const packCache = new Map<string, ResolvedPackData>();
  for (const [rawId, rawSource] of entries) {
    if (FORBIDDEN_PROTOTYPE_KEYS.has(rawId)) {
      throw new SkillRegistryError(
        'invalid_skill_id',
        `DaemonConfig.skills must not use prototype key ${JSON.stringify(rawId)}`,
        { skillId: rawId },
      );
    }
    const parsedId = SkillIdSchema.safeParse(rawId);
    if (!parsedId.success) {
      throw new SkillRegistryError(
        'invalid_skill_id',
        `DaemonConfig.skills contains invalid skill id ${JSON.stringify(rawId)}`,
        { skillId: rawId },
      );
    }
    const skillId = parsedId.data;
    const source = validateSkillSource(skillId, rawSource);
    const snapshot = 'path' in source
      ? resolvePathSkillSync(skillId, source)
      : resolvePackSkillSync(skillId, source, dataDir, packCache);
    resolved.set(skillId, snapshot);
  }

  const configuredSkills = Object.freeze([...resolved.keys()]);
  const canonical = configuredSkills.map((id) => {
    const entry = resolved.get(id)!;
    return [
      id,
      entry.contentHash as string,
      'path' in entry.source ? ['path', entry.source.path] : ['pack', entry.source.pack],
      entry.rootDir,
      entry.packVersion ?? null,
    ] as const;
  });

  return Object.freeze({
    revision: digestJson(canonical),
    skills: resolved,
    configuredSkills,
  });
}

/** Single synchronous owner of bytes-locked, immutable-at-a-time device-local skill snapshots. */
export class SkillRegistry {
  private state: SkillRegistrySnapshot;
  private readonly dataDir: string | undefined;

  constructor(configured?: SkillConfigInput, options: SkillRegistryOptions = {}) {
    this.dataDir = options.dataDir;
    this.state = buildSnapshot(configured, this.dataDir);
  }

  snapshot(): SkillRegistrySnapshot {
    return this.state;
  }

  /** Canonical `<dataDir>/skill-packs/<name>/<sha256-hex>` directories pinned by the live snapshot. */
  pinnedPackDirectories(): ReadonlySet<string> {
    const dirs = new Set<string>();
    for (const entry of this.state.skills.values()) {
      if (entry.sourceKind === 'pack') dirs.add(entry.rootDir);
    }
    return dirs;
  }

  status(): SkillRegistryStatus {
    return Object.freeze({
      revision: this.state.revision,
      configuredSkills: this.state.configuredSkills,
      skills: Object.freeze(this.statusRows()),
    });
  }

  reload(skills: SkillConfigInput, expectedRevision: string): SkillReloadReceipt {
    if (!REVISION_PATTERN.test(expectedRevision)) {
      throw new SkillRegistryError('invalid_revision', 'expectedRevision must be a sha256 content revision');
    }
    if (expectedRevision !== this.state.revision) {
      throw new SkillRevisionConflictError(expectedRevision, this.state.revision);
    }
    const previousRevision = this.state.revision;
    const candidate = buildSnapshot(skills, this.dataDir);
    if (candidate.revision === previousRevision) {
      return Object.freeze({
        previousRevision,
        revision: previousRevision,
        changed: false,
        configuredSkills: this.state.configuredSkills,
        skills: Object.freeze(this.statusRows()),
      });
    }
    this.state = candidate;
    return Object.freeze({
      previousRevision,
      revision: candidate.revision,
      changed: true,
      configuredSkills: this.state.configuredSkills,
      skills: Object.freeze(this.statusRows()),
    });
  }

  private statusRows(): Readonly<SkillEntryStatus>[] {
    return this.state.configuredSkills.map((id) => {
      const entry = this.state.skills.get(id)!;
      return Object.freeze({
        id: entry.id,
        source: entry.source,
        name: entry.name,
        description: entry.description,
        contentHash: entry.contentHash,
        ...(entry.packVersion === undefined ? {} : { packVersion: entry.packVersion }),
        status: 'verified' as const,
      });
    });
  }
}
