/**
 * Skill pack installation, device side (plan `skill-pack-delivery-channel`).
 *
 * The pipeline is: read the deployment's ADR-010 declaration → fetch the
 * manifest list → fetch each file → verify EVERY declared limit against the
 * bytes that actually arrived → write into a content-addressed store → write a
 * lock file → append an audit line. Any failure at any step refuses the whole
 * pack; there is no partial install and no degraded mode.
 *
 * Three properties worth stating outright, because each is a thing that could
 * have been done more conveniently and wrong:
 *
 * 1. **Capability first, fetch second.** {@link installSkillPacks} asserts
 *    `skills.pack` against the declaration BEFORE issuing any request, and
 *    throws {@link SkillPackInstallError} with code `capability_unavailable`.
 *    Not because the request would fail — a deployment without the capability
 *    does not mount the routes, so it would 404 — but because reading a 404 as
 *    "no packs" is precisely the status-code sniffing ADR-010 exists to remove.
 * 2. **Content-addressed, never in place.** A pack lands under
 *    `<dataDir>/skill-packs/<name>/<hash>/`, which is written fresh and only
 *    then pointed at by `lock.json`. A device therefore never has a half-
 *    overwritten pack: the previous version stays intact and addressable until
 *    the new one is complete.
 * 3. **Copy, never symlink.** {@link projectSkillPack} copies bytes into the
 *    host's target directory. A symlink would make the projected skill mutate
 *    under a runtime whenever the store changed, and would export the store's
 *    own layout into a directory the host owns.
 *
 * What this module does NOT do: decide where a vendor CLI keeps its skills.
 * That layout is host policy (K4). The SDK owns its own store and hands the
 * host a projection call; it never writes to `~/.claude/skills` or its
 * equivalents.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CONTENT_HASH_PATTERN,
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_MAX_BYTES,
  checkSkillPackEntry,
  checkSkillPackFileContent,
  checkSkillPackManifest,
  contentHash,
  hasCapability,
  isSkillPackPathSafe,
  parseSkillPackManifest,
  skillPackContentHashInput,
  type CapabilityDeclaration,
  type ContentHash,
  type SkillPackCheck,
  type SkillPackManifest,
} from '@byok-sdk/core';
import { BYOK_SKILL_PACKS_PATH, byokSkillPackFilePath } from '@byok-sdk/protocol';
import type { AuthManager } from './auth-manager';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';
import { atomicWriteFile } from '../util/atomic-write';

/**
 * The hosted capability this pipeline gates on. A plain string, not an import
 * from `@byok-sdk/cloud`: the daemon must not gain a dependency on the hosted
 * implementation, and ADR-010 makes capability names deployment vocabulary that
 * core validates the shape of but never the meaning of. Same rule the presence
 * producer's `PRESENCE_HINTS_CAPABILITY` follows.
 */
export const SKILL_PACKS_CAPABILITY = 'skills.pack';

/** Directory under `dataDir` this module owns end to end. */
export const SKILL_PACKS_DIRNAME = 'skill-packs';
/** Per-pack pointer at the installed content-addressed revision. */
export const SKILL_PACK_LOCK_FILENAME = 'lock.json';
/** Append-only install/refusal record, beside the packs it describes. */
export const SKILL_PACK_AUDIT_FILENAME = 'audit.jsonl';
export const SKILL_PACK_LOCK_SCHEMA = 'byok-skill-pack-lock-v1';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Ceiling on a single HTTP response this pipeline will read into memory.
 *
 * Deliberately derived from the pack cap rather than chosen independently: the
 * largest legitimate manifest list is bounded by what a pack may declare, and a
 * response beyond that is refused before it is parsed rather than after. A
 * transfer cap that is not evaluated is the exact failure this plan set out not
 * to repeat.
 */
export const SKILL_PACK_RESPONSE_MAX_BYTES = SKILL_PACK_MAX_BYTES * 2;

export const SKILL_PACK_INSTALL_ERROR_CODES = [
  'capability_unavailable',
  'transport_failed',
  'response_invalid',
  'response_too_large',
  'manifest_invalid',
  'content_rejected',
  'store_unsafe',
] as const;
export type SkillPackInstallErrorCode = (typeof SKILL_PACK_INSTALL_ERROR_CODES)[number];

/**
 * Every way an install can be refused, as one type with a `code`.
 *
 * Code-based branching rather than a class per failure — the same idiom
 * `@byok-sdk/core` uses — because a caller only ever needs two decisions from
 * this: "was the channel unavailable" (retry later, or the deployment simply
 * does not offer it) versus "was the content refused" (a publication problem
 * nobody on this device can fix by retrying).
 */
export class SkillPackInstallError extends Error {
  public readonly code: SkillPackInstallErrorCode;
  public readonly packName: string | undefined;

  constructor(
    code: SkillPackInstallErrorCode,
    message: string,
    options: { cause?: unknown; packName?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SkillPackInstallError';
    this.code = code;
    this.packName = options.packName;
  }
}

/** What a device recorded about one installed pack. Mirrors `lock.json` on disk. */
export interface SkillPackLock {
  readonly schema: typeof SKILL_PACK_LOCK_SCHEMA;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly content_hash: string;
  /** The deployment the pack came from, normalized to its http(s) origin. Never a token, never a path. */
  readonly source: string;
  readonly installed_at: string;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
}

export interface InstalledSkillPack {
  readonly name: string;
  readonly lock: SkillPackLock;
  /** Absolute path of the content-addressed revision `lock.json` points at. */
  readonly directory: string;
}

export interface InstallSkillPacksOptions {
  /** The SDK data directory. A daemon passes its `storeDir`; the pack tree lives beside its other private state. */
  readonly dataDir: string;
  readonly serverUrl: string;
  readonly auth: AuthManager;
  /** The declaration read from `GET /byok/capabilities`. Never re-derived here, and never assumed. */
  readonly declaration: CapabilityDeclaration;
  readonly signal?: AbortSignal;
}

export interface SkillPackInstallResult {
  readonly installed: readonly InstalledSkillPack[];
  /** Packs already present at the same content hash. Re-installing is a no-op, not a rewrite. */
  readonly unchanged: readonly string[];
}

function hashBytes(bytes: Uint8Array): ContentHash {
  return contentHash(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function originOf(serverUrl: string): string {
  return new URL(toHttpBase(serverUrl)).origin;
}

/**
 * Reads a bounded JSON body.
 *
 * `content-length` is a hint and is checked when present, but the streamed
 * length is checked unconditionally — a chunked response has no length header
 * at all, and trusting the header alone is how a declared cap becomes
 * decorative.
 */
async function readBoundedJson(response: Response, what: string): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isSafeInteger(parsed) && parsed > SKILL_PACK_RESPONSE_MAX_BYTES) {
      throw new SkillPackInstallError(
        'response_too_large',
        `${what} declared ${parsed} bytes, over the ${SKILL_PACK_RESPONSE_MAX_BYTES} byte response limit.`,
      );
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > SKILL_PACK_RESPONSE_MAX_BYTES) {
    throw new SkillPackInstallError(
      'response_too_large',
      `${what} delivered ${bytes.byteLength} bytes, over the ${SKILL_PACK_RESPONSE_MAX_BYTES} byte response limit.`,
    );
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new SkillPackInstallError('response_invalid', `${what} is not valid JSON.`, { cause });
  }
}

async function getJson(
  url: URL,
  auth: AuthManager,
  signal: AbortSignal | undefined,
  what: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await authedFetch(url, { method: 'GET', ...(signal === undefined ? {} : { signal }) }, auth);
  } catch (cause) {
    throw new SkillPackInstallError('transport_failed', `${what} could not be fetched from ${url.toString()}.`, {
      cause,
    });
  }
  if (!response.ok) {
    throw new SkillPackInstallError('transport_failed', `${what} answered HTTP ${response.status}.`);
  }
  return readBoundedJson(response, what);
}

/** The store root this module owns. */
export function skillPacksRoot(dataDir: string): string {
  return path.join(dataDir, SKILL_PACKS_DIRNAME);
}

/**
 * Joins a pack-relative path onto a base directory, refusing anything that does
 * not stay inside it.
 *
 * Core's path rule already makes traversal unexpressible, and this is checked
 * again anyway: the two checks fail for different reasons (a grammar violation
 * versus a resolved path that escaped), and the one that runs immediately
 * before the write is the one that has the final say about where bytes land.
 */
function resolveInside(baseDir: string, relative: string): string {
  if (!isSkillPackPathSafe(relative)) {
    throw new SkillPackInstallError('store_unsafe', `${JSON.stringify(relative)} is not a safe pack-relative path.`);
  }
  const resolved = path.resolve(baseDir, relative);
  const prefix = path.resolve(baseDir) + path.sep;
  if (!resolved.startsWith(prefix)) {
    throw new SkillPackInstallError(
      'store_unsafe',
      `${JSON.stringify(relative)} resolves outside ${baseDir}.`,
    );
  }
  return resolved;
}

/** Refuses a path whose final component is a symlink, before reading or writing through it. */
async function assertNotSymlink(target: string): Promise<void> {
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stats.isSymbolicLink()) {
    throw new SkillPackInstallError('store_unsafe', `${target} is a symbolic link; refusing to follow it.`);
  }
}

async function appendAuditLine(dataDir: string, record: Record<string, unknown>): Promise<void> {
  const root = skillPacksRoot(dataDir);
  await fs.mkdir(root, { recursive: true, mode: DIR_MODE });
  await fs.chmod(root, DIR_MODE).catch(() => {});
  const filePath = path.join(root, SKILL_PACK_AUDIT_FILENAME);
  const handle = await fs.open(filePath, 'a', FILE_MODE);
  try {
    // chmod BEFORE the append, for the same reason `bin/audit-log.ts` does it:
    // `open`'s mode governs creation only, so a pre-existing permissive file
    // would otherwise take the new line while still world-readable.
    await handle.chmod(FILE_MODE);
    await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Fetches, verifies and installs every pack this deployment offers.
 *
 * @throws {SkillPackInstallError} `capability_unavailable` before any request
 * is issued when the declaration does not name `skills.pack`.
 */
export async function installSkillPacks(
  options: InstallSkillPacksOptions,
): Promise<SkillPackInstallResult> {
  if (!hasCapability(options.declaration, SKILL_PACKS_CAPABILITY)) {
    // Before the fetch, deliberately. A deployment that does not declare the
    // channel does not mount the routes, and a 404 read as "no packs available"
    // is indistinguishable from a proxy having eaten the request.
    throw new SkillPackInstallError(
      'capability_unavailable',
      `This deployment does not declare ${SKILL_PACKS_CAPABILITY}; refusing to fetch skill packs.`,
    );
  }

  const base = toHttpBase(options.serverUrl);
  const source = originOf(options.serverUrl);
  const body = await getJson(
    new URL(BYOK_SKILL_PACKS_PATH, base),
    options.auth,
    options.signal,
    'the skill pack manifest list',
  );
  const rawPacks = (body as { packs?: unknown } | null)?.packs;
  if (!Array.isArray(rawPacks)) {
    throw new SkillPackInstallError('response_invalid', 'the skill pack manifest list has no `packs` array.');
  }

  const installed: InstalledSkillPack[] = [];
  const unchanged: string[] = [];
  for (const raw of rawPacks) {
    const manifest = parseManifest(raw);
    const existing = await readLock(options.dataDir, manifest.name);
    if (existing?.lock.content_hash === (manifest.contentHash as string)) {
      unchanged.push(manifest.name);
      continue;
    }
    installed.push(await installOne(options, manifest, source, base));
  }
  return { installed, unchanged };
}

function parseManifest(raw: unknown): SkillPackManifest {
  let manifest: SkillPackManifest;
  try {
    manifest = parseSkillPackManifest(raw);
  } catch (cause) {
    throw new SkillPackInstallError('manifest_invalid', 'a published skill pack manifest is not valid.', { cause });
  }
  const structural = checkSkillPackManifest(manifest);
  if (!structural.ok) {
    throw new SkillPackInstallError(
      'manifest_invalid',
      `skill pack ${JSON.stringify(manifest.name)} was refused: ${structural.reason} — ${structural.detail}`,
      { packName: manifest.name },
    );
  }
  return manifest;
}

async function installOne(
  options: InstallSkillPacksOptions,
  manifest: SkillPackManifest,
  source: string,
  base: string,
): Promise<InstalledSkillPack> {
  const refuse = async (code: SkillPackInstallErrorCode, message: string): Promise<never> => {
    await appendAuditLine(options.dataDir, {
      ts: new Date().toISOString(),
      event: 'skill-pack-rejected',
      name: manifest.name,
      contentHash: manifest.contentHash as string,
      source,
      code,
      reason: message,
    });
    throw new SkillPackInstallError(code, message, { packName: manifest.name });
  };

  // The pack address is re-derived locally from the manifest's own rows. A
  // published `contentHash` that does not match what those rows imply means the
  // catalogue disagrees with itself, and there is no version of that worth
  // installing.
  const expectedPackHash = hashBytes(new TextEncoder().encode(skillPackContentHashInput(manifest)));
  if ((expectedPackHash as string) !== (manifest.contentHash as string)) {
    await refuse(
      'manifest_invalid',
      `skill pack ${JSON.stringify(manifest.name)} declares ${manifest.contentHash as string} but its file rows address ${expectedPackHash as string}.`,
    );
  }

  const bodies = new Map<string, string>();
  let totalBytes = 0;
  for (const declared of manifest.files) {
    const url = new URL(byokSkillPackFilePath(manifest.name, declared.path), base);
    const raw = await getJson(url, options.auth, options.signal, `skill pack file ${JSON.stringify(declared.path)}`);
    const content = (raw as { content?: unknown } | null)?.content;
    if (typeof content !== 'string') {
      await refuse('response_invalid', `skill pack file ${JSON.stringify(declared.path)} carried no string content.`);
    }
    const bytes = new TextEncoder().encode(content as string);
    const check = checkSkillPackFileContent(declared, {
      byteSize: bytes.byteLength,
      contentHash: hashBytes(bytes),
    });
    if (!check.ok) {
      await refuse('content_rejected', `skill pack ${JSON.stringify(manifest.name)}: ${check.reason} — ${check.detail}`);
    }
    // No cumulative cap check here on purpose: `checkSkillPackManifest` already
    // refused any manifest whose declared bytes sum past `SKILL_PACK_MAX_BYTES`,
    // and `checkSkillPackFileContent` above refused any file whose delivered
    // bytes differ from what it declared — so this running total is bounded by
    // the manifest-level guarantee and can never exceed the cap. A branch that
    // cannot fire is a decorative limit, and this pipeline does not carry those.
    totalBytes += bytes.byteLength;
    bodies.set(declared.path, content as string);
  }

  const entryText = bodies.get(SKILL_PACK_ENTRY_PATH);
  if (entryText === undefined) {
    await refuse('content_rejected', `skill pack ${JSON.stringify(manifest.name)}: entry-missing — ${SKILL_PACK_ENTRY_PATH} was not delivered.`);
  }
  let entryCheck: SkillPackCheck | undefined;
  try {
    entryCheck = checkSkillPackEntry(manifest, entryText!);
  } catch (cause) {
    await refuse(
      'content_rejected',
      `skill pack ${JSON.stringify(manifest.name)}: ${SKILL_PACK_ENTRY_PATH} frontmatter was refused (${cause instanceof Error ? cause.message : String(cause)}).`,
    );
  }
  if (!entryCheck!.ok) {
    await refuse('content_rejected', `skill pack ${JSON.stringify(manifest.name)}: ${entryCheck!.reason} — ${entryCheck!.detail}`);
  }

  const packRoot = path.join(skillPacksRoot(options.dataDir), manifest.name);
  const revisionDir = path.join(packRoot, (manifest.contentHash as string).slice('sha256:'.length));
  await fs.mkdir(revisionDir, { recursive: true, mode: DIR_MODE });
  for (const [relative, content] of bodies) {
    const target = resolveInside(revisionDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: DIR_MODE });
    await assertNotSymlink(target);
    await atomicWriteFile(target, content, { mode: FILE_MODE });
  }

  const lock: SkillPackLock = {
    schema: SKILL_PACK_LOCK_SCHEMA,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    content_hash: manifest.contentHash as string,
    source,
    installed_at: new Date().toISOString(),
    files: manifest.files.map((file) => ({
      path: file.path,
      sha256: file.contentHash as string,
      bytes: file.byteSize,
    })),
  };
  // The lock lands LAST: until it does, the revision directory is content
  // nobody points at, and the previously installed revision stays authoritative.
  await atomicWriteFile(path.join(packRoot, SKILL_PACK_LOCK_FILENAME), `${JSON.stringify(lock, null, 2)}\n`, {
    mode: FILE_MODE,
  });

  await appendAuditLine(options.dataDir, {
    ts: lock.installed_at,
    event: 'skill-pack-installed',
    name: lock.name,
    version: lock.version,
    contentHash: lock.content_hash,
    source: lock.source,
    files: lock.files.length,
    bytes: totalBytes,
  });

  return { name: manifest.name, lock, directory: revisionDir };
}

/**
 * Shape gate for `lock.json`.
 *
 * `content_hash` is matched against the full `CONTENT_HASH_PATTERN`, not merely
 * its `sha256:` prefix: {@link readLock} slices the prefix off and joins the
 * remainder onto the pack root to name the revision directory, so anything
 * other than a 64-character hex digest there is a path component chosen by
 * whoever wrote the file. A prefix-only check would let `sha256:../../..`
 * relocate the store root, and every later containment check — including
 * {@link projectSkillPack}'s — measures against that already-escaped base.
 */
function isLockShaped(value: unknown): value is SkillPackLock {
  const lock = value as Partial<SkillPackLock> | null;
  return (
    lock !== null &&
    typeof lock === 'object' &&
    lock.schema === SKILL_PACK_LOCK_SCHEMA &&
    typeof lock.name === 'string' &&
    typeof lock.content_hash === 'string' &&
    CONTENT_HASH_PATTERN.test(lock.content_hash) &&
    Array.isArray(lock.files)
  );
}

async function readLock(dataDir: string, name: string): Promise<InstalledSkillPack | undefined> {
  if (!isSkillPackPathSafe(name)) return undefined;
  const packRoot = path.join(skillPacksRoot(dataDir), name);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(packRoot, SKILL_PACK_LOCK_FILENAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // A lock this build does not recognize is treated as absent, not as
  // permission to guess: the next install rewrites it from the manifest.
  if (!isLockShaped(parsed) || parsed.name !== name) return undefined;
  return {
    name,
    lock: parsed,
    directory: path.join(packRoot, parsed.content_hash.slice('sha256:'.length)),
  };
}

/**
 * Every pack this device has a valid lock for, sorted by name.
 *
 * Reads only the locks — never the pack bytes — so a caller listing what is
 * installed pays nothing for packs it is not about to project.
 */
export async function listInstalledSkillPacks(dataDir: string): Promise<readonly InstalledSkillPack[]> {
  let entries;
  try {
    entries = await fs.readdir(skillPacksRoot(dataDir), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const packs: InstalledSkillPack[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const installed = await readLock(dataDir, entry.name);
    if (installed !== undefined) packs.push(installed);
  }
  packs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return packs;
}

export interface ProjectedSkillPack {
  readonly name: string;
  readonly contentHash: string;
  readonly targetDir: string;
  readonly files: readonly string[];
}

/**
 * Copies an installed pack's files into a host-chosen directory.
 *
 * Copy, not symlink, and re-verified on the way out: the store is on the same
 * machine as whatever else runs there, so the bytes are hashed again and
 * compared against the lock before they are handed to a runtime. An install
 * that was verified last week is not evidence about the file on disk today.
 *
 * @throws {SkillPackInstallError} `store_unsafe` for a missing pack, a symlink
 * anywhere in the pack, or a file whose bytes no longer match the lock.
 */
export async function projectSkillPack(
  dataDir: string,
  name: string,
  targetDir: string,
): Promise<ProjectedSkillPack> {
  const installed = await readLock(dataDir, name);
  if (installed === undefined) {
    throw new SkillPackInstallError('store_unsafe', `no installed skill pack named ${JSON.stringify(name)}.`, {
      packName: name,
    });
  }

  const copied: string[] = [];
  for (const file of installed.lock.files) {
    const sourcePath = resolveInside(installed.directory, file.path);
    await assertNotSymlink(sourcePath);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(sourcePath);
    } catch (cause) {
      throw new SkillPackInstallError(
        'store_unsafe',
        `installed skill pack ${JSON.stringify(name)} is missing ${JSON.stringify(file.path)}.`,
        { cause, packName: name },
      );
    }
    if ((hashBytes(bytes) as string) !== file.sha256 || bytes.byteLength !== file.bytes) {
      throw new SkillPackInstallError(
        'store_unsafe',
        `installed skill pack ${JSON.stringify(name)} no longer matches its lock at ${JSON.stringify(file.path)}.`,
        { packName: name },
      );
    }

    const destination = resolveInside(targetDir, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: DIR_MODE });
    await assertNotSymlink(destination);
    await atomicWriteFile(destination, bytes, { mode: FILE_MODE });
    copied.push(file.path);
  }

  await appendAuditLine(dataDir, {
    ts: new Date().toISOString(),
    event: 'skill-pack-projected',
    name: installed.name,
    contentHash: installed.lock.content_hash,
    files: copied.length,
  });

  return {
    name: installed.name,
    contentHash: installed.lock.content_hash,
    targetDir: path.resolve(targetDir),
    files: copied,
  };
}
