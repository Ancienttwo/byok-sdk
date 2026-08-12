/**
 * Skill packs: declarative content a SaaS deployment distributes to a paired
 * device (plan `skill-pack-delivery-channel`, Phase 1).
 *
 * A pack is an `agentskills.io`-shaped `SKILL.md` plus its static companion
 * files. That is the WHOLE of it, and the narrowness is the design:
 *
 * 1. **No executable surface, by schema.** {@link SkillPackManifestSchema} is a
 *    `strictObject`, so an unknown key is a rejection rather than a field
 *    someone's tooling might later start honoring, and
 *    {@link SKILL_PACK_FORBIDDEN_FIELDS} names the specific ones — `exec`,
 *    `env`, `credential`, `hooks`, `allowed-tools` — that get their own
 *    rejection message. The credential-isolation rule this SDK is built around
 *    (§9.1) cannot be enforced downstream if the manifest can carry a command
 *    to run or an environment to run it in, so it is enforced here, once.
 * 2. **Every declared limit has an evaluation point in this file.** A size cap
 *    that nothing measures, a path rule that nothing checks, and a content hash
 *    that nothing verifies are the same failure: a security claim with no
 *    enforcement behind it. {@link checkSkillPackManifest} evaluates the
 *    manifest-level limits and {@link checkSkillPackFileContent} evaluates the
 *    byte-level ones, both returning a named rejection instead of a boolean, so
 *    a caller can say which limit fired.
 * 3. **Hashing lives outside core.** Core has no `node:` import and no crypto
 *    (the same rule `blob.ts` and `attestation.ts` follow), so this module owns
 *    the canonical bytes a hash is taken over ({@link skillPackContentHashInput})
 *    and the comparison, never the digest itself. The installer supplies what it
 *    observed; core decides whether that is acceptable.
 *
 * Distribution is hosted HTTP (`@byok-sdk/cloud`'s `GET /byok/skill-packs`),
 * declared through ADR-010 as `skills.pack`. Nothing here touches the frozen v1
 * wire envelope, and there is deliberately no new message type: a pack is
 * content a device PULLS after reading a declaration, not a message a server
 * pushes into a task stream.
 */
import { z } from 'zod';
import { CONTENT_HASH_PATTERN, contentHash, type ContentHash } from './blob';
import { ByokCoreError } from './errors';
import type { TenantId } from './tenant';

export const SKILL_PACK_MANIFEST_SCHEMA_ID = 'byok-skill-pack-v1';

/**
 * Pack names: lowercase, starting alphanumeric — the same shape
 * `OBJECT_KEY_PREFIX_PATTERN` accepts per segment, for the same reason. A pack
 * name becomes a directory name on a real device filesystem, so the accepted
 * set is the one that reaches disk spelled exactly as declared: no case folding
 * to collide over, no separator, no leading dot, nothing needing escaping.
 */
export const SKILL_PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const SKILL_PACK_NAME_MAX_LENGTH = 64;
export const SKILL_PACK_DESCRIPTION_MAX_LENGTH = 1024;

/** `MAJOR.MINOR.PATCH`. A pack version orders two publications of one name; it is not a range language. */
export const SKILL_PACK_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Relative POSIX paths only: slash-joined segments of alphanumerics, `.`, `_`
 * and `-`, each STARTING with an alphanumeric.
 *
 * That single "starts with an alphanumeric" rule is what closes the traversal
 * class rather than a blocklist of spellings: `..` cannot match (a segment may
 * not begin with `.`), an absolute path cannot match (no leading slash), an
 * empty segment cannot match (`a//b`), a Windows drive or UNC path cannot match
 * (no `:`, no `\`), a home-relative path cannot match (no `~`), and a dotfile
 * cannot match either. A blocklist would have to anticipate every encoding of
 * the same idea; this allowlist has nothing to anticipate.
 */
export const SKILL_PACK_FILE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const SKILL_PACK_FILE_PATH_MAX_LENGTH = 200;

/** The entry file every pack must carry, spelled as `agentskills.io` spells it. */
export const SKILL_PACK_ENTRY_PATH = 'SKILL.md';

/** Per-file ceiling, measured in BYTES over the observed content — never in characters. */
export const SKILL_PACK_FILE_MAX_BYTES = 262_144;
/** Whole-pack ceiling, over the sum of the observed file sizes. */
export const SKILL_PACK_MAX_BYTES = 1_048_576;
export const SKILL_PACK_MAX_FILES = 64;

/**
 * Manifest keys that must never exist, listed so the prohibition is testable
 * rather than implied.
 *
 * `strictObject` already rejects every unknown key, so this list adds no new
 * authority — it adds a NAMED rejection for the subset that matters: an
 * operator who sees `unrecognized key: "env"` learns nothing about why, and a
 * reviewer reading the schema cannot tell whether the omission was a decision
 * or an oversight. Pinned from both directions by
 * `__tests__/skill-pack.test.ts`.
 */
export const SKILL_PACK_FORBIDDEN_FIELDS = [
  'exec',
  'command',
  'entrypoint',
  'run',
  'script',
  'shell',
  'env',
  'environment',
  'credential',
  'credentials',
  'secret',
  'secrets',
  'token',
  'apiKey',
  'api_key',
  'allowedTools',
  'allowed-tools',
  'hooks',
  'preinstall',
  'postinstall',
] as const;

const ContentHashSchema = z
  .string()
  .regex(CONTENT_HASH_PATTERN)
  .transform((value) => contentHash(value));

/** One file in a pack: where it goes, what it must hash to, and how big it is. */
export const SkillPackFileSchema = z.strictObject({
  path: z.string().min(1).max(SKILL_PACK_FILE_PATH_MAX_LENGTH).regex(SKILL_PACK_FILE_PATH_PATTERN),
  contentHash: ContentHashSchema,
  byteSize: z.number().int().nonnegative().max(SKILL_PACK_FILE_MAX_BYTES),
});

export type SkillPackFile = z.infer<typeof SkillPackFileSchema>;

/**
 * The published description of one pack.
 *
 * `contentHash` addresses the manifest AS A WHOLE — see
 * {@link skillPackContentHashInput} — which is what makes an install
 * content-addressed: two publications that differ in any field a device can
 * observe land in two directories, and re-installing an unchanged pack is a
 * no-op rather than a partial overwrite.
 */
export const SkillPackManifestSchema = z.strictObject({
  schema: z.literal(SKILL_PACK_MANIFEST_SCHEMA_ID),
  name: z.string().min(1).max(SKILL_PACK_NAME_MAX_LENGTH).regex(SKILL_PACK_NAME_PATTERN),
  version: z.string().regex(SKILL_PACK_VERSION_PATTERN),
  description: z.string().min(1).max(SKILL_PACK_DESCRIPTION_MAX_LENGTH),
  files: z.array(SkillPackFileSchema).min(1).max(SKILL_PACK_MAX_FILES),
  contentHash: ContentHashSchema,
});

export type SkillPackManifest = z.infer<typeof SkillPackManifestSchema>;

/**
 * Parses a manifest fail-closed.
 *
 * @throws {ByokCoreError} code `skill_pack_manifest_invalid`.
 */
export function parseSkillPackManifest(input: unknown): SkillPackManifest {
  if (typeof input === 'object' && input !== null) {
    const present = SKILL_PACK_FORBIDDEN_FIELDS.filter((field) =>
      Object.prototype.hasOwnProperty.call(input, field),
    );
    if (present.length > 0) {
      throw new ByokCoreError(
        'skill_pack_manifest_invalid',
        `A skill pack manifest carries no executable or credential surface; refusing ${present
          .map((field) => JSON.stringify(field))
          .join(', ')}.`,
      );
    }
  }
  const result = SkillPackManifestSchema.safeParse(input);
  if (!result.success) {
    throw new ByokCoreError(
      'skill_pack_manifest_invalid',
      `Invalid skill pack manifest: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * The exact bytes `manifest.contentHash` is the sha256 of.
 *
 * Written out here, in core, because both ends have to agree on it and neither
 * end may derive its own version: the publisher hashes this string to mint the
 * address, the installer hashes it again to verify what it fetched, and a
 * disagreement between the two would make every install either falsely
 * accepted or unconditionally rejected. Newline-delimited and terminated so no
 * field's content can be shifted into the next field's position, and the file
 * rows are sorted by path so two publishers that enumerate a directory in
 * different orders still mint the same address.
 */
export function skillPackContentHashInput(manifest: {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly files: readonly SkillPackFile[];
}): string {
  const rows = [...manifest.files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => `${file.path}\n${file.contentHash as string}\n${file.byteSize}\n`);
  return [
    `${SKILL_PACK_MANIFEST_SCHEMA_ID}\n`,
    `${manifest.name}\n`,
    `${manifest.version}\n`,
    `${manifest.description.length}\n`,
    `${manifest.description}\n`,
    `${manifest.files.length}\n`,
    ...rows,
  ].join('');
}

/** Every way a pack can be refused. One name per declared limit — see {@link SkillPackCheck}. */
export const SKILL_PACK_REJECTIONS = [
  'path-unsafe',
  'duplicate-path',
  'entry-missing',
  'file-count-over-cap',
  'file-over-cap',
  'pack-over-cap',
  'size-mismatch',
  'hash-mismatch',
  'name-mismatch',
] as const;
export type SkillPackRejection = (typeof SKILL_PACK_REJECTIONS)[number];

/**
 * Outcome of a check. `bytes` is the measured total on the accept path so a
 * caller can record what it admitted; a rejection always names WHICH limit
 * fired, because "the pack was rejected" is not an operable message.
 */
export type SkillPackCheck =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: SkillPackRejection; readonly detail: string };

/** Non-throwing path-safety predicate — the one authority on what a pack may name. */
export function isSkillPackPathSafe(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= SKILL_PACK_FILE_PATH_MAX_LENGTH &&
    SKILL_PACK_FILE_PATH_PATTERN.test(path)
  );
}

/**
 * The manifest-level limits, evaluated.
 *
 * Runs over a manifest that has already parsed, so the per-field caps zod owns
 * are not re-litigated here. What is left is everything zod cannot see: the
 * relationships BETWEEN files (a duplicate path, a missing entry file, a total
 * that clears every per-file cap and still blows the pack cap).
 */
export function checkSkillPackManifest(manifest: SkillPackManifest): SkillPackCheck {
  if (manifest.files.length > SKILL_PACK_MAX_FILES) {
    return {
      ok: false,
      reason: 'file-count-over-cap',
      detail: `${manifest.files.length} files exceeds the ${SKILL_PACK_MAX_FILES} file limit.`,
    };
  }

  const seen = new Set<string>();
  let bytes = 0;
  for (const file of manifest.files) {
    if (!isSkillPackPathSafe(file.path)) {
      return { ok: false, reason: 'path-unsafe', detail: `${JSON.stringify(file.path)} is not a safe relative path.` };
    }
    if (seen.has(file.path)) {
      return { ok: false, reason: 'duplicate-path', detail: `${JSON.stringify(file.path)} is declared twice.` };
    }
    seen.add(file.path);
    if (file.byteSize > SKILL_PACK_FILE_MAX_BYTES) {
      return {
        ok: false,
        reason: 'file-over-cap',
        detail: `${JSON.stringify(file.path)} declares ${file.byteSize} bytes, over the ${SKILL_PACK_FILE_MAX_BYTES} byte per-file limit.`,
      };
    }
    bytes += file.byteSize;
  }

  if (!seen.has(SKILL_PACK_ENTRY_PATH)) {
    return {
      ok: false,
      reason: 'entry-missing',
      detail: `A skill pack must carry ${SKILL_PACK_ENTRY_PATH}.`,
    };
  }
  if (bytes > SKILL_PACK_MAX_BYTES) {
    return {
      ok: false,
      reason: 'pack-over-cap',
      detail: `${bytes} declared bytes exceeds the ${SKILL_PACK_MAX_BYTES} byte pack limit.`,
    };
  }
  return { ok: true, bytes };
}

/** What an installer actually measured for one file, as opposed to what the manifest declared. */
export interface ObservedSkillPackFile {
  readonly byteSize: number;
  readonly contentHash: ContentHash;
}

/**
 * The byte-level limits, evaluated against what was actually fetched.
 *
 * The asymmetry with {@link checkSkillPackManifest} is the point: the declared
 * size is a claim by the publisher and the observed size is a fact about the
 * bytes on the device, so the cap is enforced on the OBSERVED value. A check
 * that only ever measured the declaration would pass a 4 KiB manifest row
 * attached to a 40 MiB response.
 */
export function checkSkillPackFileContent(
  declared: SkillPackFile,
  observed: ObservedSkillPackFile,
): SkillPackCheck {
  if (!isSkillPackPathSafe(declared.path)) {
    return { ok: false, reason: 'path-unsafe', detail: `${JSON.stringify(declared.path)} is not a safe relative path.` };
  }
  if (observed.byteSize > SKILL_PACK_FILE_MAX_BYTES) {
    return {
      ok: false,
      reason: 'file-over-cap',
      detail: `${JSON.stringify(declared.path)} delivered ${observed.byteSize} bytes, over the ${SKILL_PACK_FILE_MAX_BYTES} byte per-file limit.`,
    };
  }
  if (observed.byteSize !== declared.byteSize) {
    return {
      ok: false,
      reason: 'size-mismatch',
      detail: `${JSON.stringify(declared.path)} declared ${declared.byteSize} bytes and delivered ${observed.byteSize}.`,
    };
  }
  if ((observed.contentHash as string) !== (declared.contentHash as string)) {
    return {
      ok: false,
      reason: 'hash-mismatch',
      detail: `${JSON.stringify(declared.path)} declared ${declared.contentHash as string} and delivered ${observed.contentHash as string}.`,
    };
  }
  return { ok: true, bytes: observed.byteSize };
}

/**
 * `SKILL.md` frontmatter, in the `agentskills.io` shape: exactly `name` and
 * `description`, both required.
 *
 * The allowlist is the whole contract. `allowed-tools`, `hooks` and friends are
 * real fields in other skill dialects and every one of them widens what a pack
 * can ask a runtime to do; a parser that merely IGNORED them would still let a
 * pack ship them to a host that does not.
 */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}

/** The only frontmatter keys a pack may declare. */
export const SKILL_FRONTMATTER_FIELDS = ['name', 'description'] as const;

const FRONTMATTER_DELIMITER = '---';
const FRONTMATTER_LINE_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;

function unquote(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      return inner.includes(first) ? undefined : inner;
    }
  }
  return trimmed;
}

/**
 * Parses and validates a `SKILL.md`'s frontmatter block.
 *
 * Deliberately not a YAML engine: this is a closed two-key grammar, and the
 * whole reason to hand-write it is that a general parser would happily accept
 * anchors, aliases, nested maps, multi-document streams and block scalars —
 * every one of which is a way to express something this format has decided not
 * to have. Anything outside the grammar is a rejection, never a skipped line.
 *
 * @throws {ByokCoreError} code `skill_pack_frontmatter_invalid`.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const reject = (message: string): never => {
    throw new ByokCoreError('skill_pack_frontmatter_invalid', message);
  };

  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== FRONTMATTER_DELIMITER) {
    reject(`A skill file must open with a ${FRONTMATTER_DELIMITER} frontmatter delimiter.`);
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trimEnd() === FRONTMATTER_DELIMITER);
  if (closing < 0) reject(`The frontmatter block is not closed by a ${FRONTMATTER_DELIMITER} line.`);

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, closing)) {
    if (line.trim().length === 0) continue;
    const match = FRONTMATTER_LINE_PATTERN.exec(line);
    if (match === null) reject(`Frontmatter line ${JSON.stringify(line)} is not a \`key: value\` pair.`);
    const key = match![1]!;
    if (!(SKILL_FRONTMATTER_FIELDS as readonly string[]).includes(key)) {
      reject(
        `Frontmatter key ${JSON.stringify(key)} is not one of ${SKILL_FRONTMATTER_FIELDS.join(', ')}; a skill declares no tools, hooks, or environment.`,
      );
    }
    if (fields.has(key)) reject(`Frontmatter key ${JSON.stringify(key)} is declared twice.`);
    const value = unquote(match![2]!);
    if (value === undefined || value.length === 0) {
      reject(`Frontmatter key ${JSON.stringify(key)} has no usable value.`);
    }
    fields.set(key, value!);
  }

  const name = fields.get('name');
  const description = fields.get('description');
  if (name === undefined) reject('Frontmatter is missing `name`.');
  if (description === undefined) reject('Frontmatter is missing `description`.');
  if (name!.length > SKILL_PACK_NAME_MAX_LENGTH || !SKILL_PACK_NAME_PATTERN.test(name!)) {
    reject(
      `Frontmatter \`name\` must match ${SKILL_PACK_NAME_PATTERN.source} and be at most ${SKILL_PACK_NAME_MAX_LENGTH} characters.`,
    );
  }
  if (description!.length > SKILL_PACK_DESCRIPTION_MAX_LENGTH) {
    reject(`Frontmatter \`description\` exceeds ${SKILL_PACK_DESCRIPTION_MAX_LENGTH} characters.`);
  }
  return { name: name!, description: description! };
}

/**
 * The entry file's own declaration must agree with the manifest's.
 *
 * Two authorities naming the same pack is not a redundancy to tolerate — a
 * device that installed under one name and handed the runtime a skill calling
 * itself another would be projecting content nobody asked for.
 */
export function checkSkillPackEntry(manifest: SkillPackManifest, entryText: string): SkillPackCheck {
  const frontmatter = parseSkillFrontmatter(entryText);
  if (frontmatter.name !== manifest.name) {
    return {
      ok: false,
      reason: 'name-mismatch',
      detail: `${SKILL_PACK_ENTRY_PATH} declares ${JSON.stringify(frontmatter.name)} but the manifest declares ${JSON.stringify(manifest.name)}.`,
    };
  }
  return { ok: true, bytes: new TextEncoder().encode(entryText).length };
}

/** One file's bytes, as the distribution surface hands them over. */
export interface SkillPackFileContent {
  readonly path: string;
  readonly contentHash: ContentHash;
  readonly byteSize: number;
  /** UTF-8 text. A pack carries Markdown, YAML and static text assets — never binaries, never archives. */
  readonly content: string;
}

/** What a publisher hands the store: the validated manifest plus the bytes it addresses. */
export interface SkillPackPublishInput {
  readonly manifest: SkillPackManifest;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

export interface SkillPackListQuery {
  readonly limit?: number;
}

/**
 * Skill pack port. Tenant-first, async, content plus manifest.
 *
 * Registered in `ports-contract.ts` as a core PORT, and deliberately not (yet)
 * a member of `CoreStores`: a composition contract that named it would oblige
 * every existing composition to implement it in the same slice, and the
 * Postgres implementation is Phase 2 of this plan. See `ports-contract.ts` for
 * the full note on that split.
 *
 * Raises: `skill_pack_manifest_invalid` (a publish whose bytes disagree with
 * the manifest it was handed).
 */
export interface SkillPackStore {
  /** Idempotent per (tenant, name, contentHash). Publishing a changed pack under the same name replaces it. */
  publish(tenant: TenantId, input: SkillPackPublishInput): Promise<SkillPackManifest>;
  get(tenant: TenantId, name: string): Promise<SkillPackManifest | undefined>;
  list(tenant: TenantId, query: SkillPackListQuery): Promise<readonly SkillPackManifest[]>;
  readFile(tenant: TenantId, name: string, path: string): Promise<SkillPackFileContent | undefined>;
}
