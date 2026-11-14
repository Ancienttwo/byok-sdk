import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonObject } from '@byok-sdk/core';

/** The manifest every payload directory carries at its root. */
export const SERVICE_PAYLOAD_MANIFEST = 'byok-payload.json';

/**
 * A payload's manifest (#1097). The Host verifies the payload's signature
 * before handing it to the SDK; the SDK checks every file against `files`
 * and accepts no file the manifest does not list.
 */
export interface ServicePayloadManifest {
  format: 'byok-service-payload';
  version: 1;
  /** The version id: 1-64 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. Becomes `versions/<id>`. */
  id: string;
  /** Every file of the payload except the manifest: `/`-separated relative path → lowercase hex SHA-256. */
  files: Record<string, string>;
  /** Host data (#1842). Not interpreted by the SDK. Must be a JSON object. */
  meta?: JsonObject;
}

export const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function isPayloadPath(relative: string): boolean {
  return relative !== SERVICE_PAYLOAD_MANIFEST && relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'));
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Two payload paths, or two of their directories, that a volume ignoring
 * letter case or Unicode normalization could store as one entry, or
 * `undefined` (#1962). `byok-payload.json` takes part as a path, so a payload
 * file or directory spelled like it collides too. Such a payload cannot
 * install as listed on macOS (APFS by default) or Windows (NTFS), so the
 * manifest writer and the installer refuse it on every volume.
 *
 * Two names collide when their {@link collisionKey}s are equal. The key is
 * meant to be at least as coarse as APFS case folding with normalization and
 * NTFS's per-character uppercase table: it is unchanged by uppercasing,
 * lowercasing or normalizing any single code point (checked for every code
 * point against the runtime's Unicode tables), and both volumes' folds are
 * made of those steps. It is coarser in places, and those names are refused
 * too: `ß` and `ss`, `σ` and `ς`, and an NFC and an NFD spelling are one name,
 * though NTFS keeps each pair apart. Where the runtime's Unicode version and a
 * volume's table differ, the key errs the same way: a case pair either one
 * knows is refused.
 */
export function collidingPayloadPaths(relatives: readonly string[]): readonly [string, string] | undefined {
  const seen = new Map<string, string>();
  for (const relative of [SERVICE_PAYLOAD_MANIFEST, ...relatives]) {
    const parts = relative.split('/');
    for (let end = 1; end <= parts.length; end += 1) {
      const spelled = parts.slice(0, end).join('/');
      const key = collisionKey(spelled);
      const first = seen.get(key);
      if (first === undefined) seen.set(key, spelled);
      else if (first !== spelled) return [first, spelled];
    }
  }
  return undefined;
}

/**
 * NFC, then each code point uppercased and each resulting code point
 * lowercased, twice, then NFC again. Per code point, so JavaScript's
 * final-sigma rule does not apply (`σ`, `ς` and `Σ` all become `σ`). Twice,
 * because one pass takes `ẞ` only to `ß`; the last NFC recomposes what
 * uppercasing decomposed (`ΐ`). The result depends on the runtime's Unicode
 * tables (Node 24: Unicode 17); the every-code-point check in the
 * installation tests runs on each Node version and fails if an upgrade
 * breaks the property {@link collidingPayloadPaths} relies on.
 *
 * @internal Exported for that check.
 */
export function collisionKey(name: string): string {
  const each = (text: string, map: (point: string) => string): string => Array.from(text, map).join('');
  const once = (text: string): string => each(each(text, (point) => point.toUpperCase()), (point) => point.toLowerCase());
  return once(once(name.normalize('NFC'))).normalize('NFC');
}

/** Every regular file under `dir`, `/`-separated and relative. Any other entry type throws `refuse(relative)`. */
export async function listPayloadFiles(dir: string, refuse: (relative: string) => Error, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await listPayloadFiles(path.join(dir, entry.name), refuse, relative));
    else if (entry.isFile()) result.push(relative);
    else throw refuse(relative);
  }
  return result;
}

/**
 * The SHA-256 of the regular file at `file`, or `refuse(file, cause)` (#1962)
 * for anything else and for any failure to read it. `lstat` must show a
 * regular file, and the descriptor opened (no-follow and non-blocking where
 * the platform defines those flags) must be a regular file with the same
 * device and inode, compared as `bigint`. So the bytes hashed are those of
 * the file `lstat` saw, and a FIFO is never waited on. Where `open` cannot
 * refuse a link (Windows), that file renamed and a link to it put in its
 * place is still read; on POSIX the link is refused. A directory above
 * `file` swapped after the listing is not caught: see
 * {@link writeServicePayloadManifest}'s input contract.
 */
export async function sha256File(file: string, refuse: (file: string, cause?: unknown) => Error): Promise<string> {
  const listed = await fs.lstat(file, { bigint: true }).catch((error: unknown) => { throw refuse(file, error); });
  if (!listed.isFile()) throw refuse(file);
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)).catch((error: unknown) => { throw refuse(file, error); });
  let digest: string | undefined;
  let failure: unknown;
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.isFile() && opened.dev === listed.dev && opened.ino === listed.ino) digest = createHash('sha256').update(await handle.readFile()).digest('hex');
  } catch (error) {
    failure = error;
  }
  // Closed before refusing, and a close failure never replaces the first one.
  await handle.close().catch((error: unknown) => { failure ??= error; digest = undefined; });
  if (digest === undefined) throw refuse(file, failure);
  return digest;
}

/**
 * Writes `byok-payload.json` for the payload in `dir` at build time (#1842)
 * and returns the bytes written. Every regular file is listed; a symlink or
 * other entry type, an existing manifest, an empty directory, an invalid id
 * a `meta` that is not a JSON object and paths that collide under
 * {@link collidingPayloadPaths} (including with `byok-payload.json` itself)
 * throw.
 *
 * Input contract (#1962): `dir` is the Host's trusted build output and
 * nothing changes it while this runs. Each file is hashed under
 * {@link sha256File}'s contract, with its platform limits; a directory above
 * a listed file that is swapped for a link after the listing can still lead
 * a read outside `dir`.
 */
export async function writeServicePayloadManifest(dir: string, options: { id: string; meta?: JsonObject }): Promise<Uint8Array> {
  if (!VERSION_ID.test(options.id)) throw new TypeError(`Invalid payload id ${JSON.stringify(options.id)}: 1-64 of A-Z a-z 0-9 . _ -, starting with a letter or digit`);
  if (options.meta !== undefined && !isJsonObject(options.meta)) throw new TypeError('Payload manifest meta must be a JSON object');
  const relatives = await listPayloadFiles(dir, (relative) => new Error(`Payload entry ${relative} is not a regular file or directory`));
  if (relatives.includes(SERVICE_PAYLOAD_MANIFEST)) throw new Error(`${path.join(dir, SERVICE_PAYLOAD_MANIFEST)} already exists`);
  if (relatives.length === 0) throw new Error(`Payload directory ${dir} has no files`);
  const colliding = collidingPayloadPaths(relatives);
  if (colliding !== undefined) throw new Error(`Payload paths ${colliding[0]} and ${colliding[1]} differ only in letter case or Unicode normalization`);
  const files: string[] = [];
  // Default sort compares UTF-16 code units, so the output does not depend on the file system's order or locale.
  for (const relative of relatives.sort()) {
    if (!isPayloadPath(relative)) throw new Error(`Payload path ${relative} cannot be listed in a manifest`);
    files.push(`    ${JSON.stringify(relative)}: "${await sha256File(path.join(dir, ...relative.split('/')), (file) => new Error(`Payload entry ${file} is not a regular file`))}"`);
  }
  // Written as text, not from an object: object key order puts integer-like paths ("9", "10") first.
  const fields = ['"format": "byok-service-payload"', '"version": 1', `"id": ${JSON.stringify(options.id)}`, `"files": {\n${files.join(',\n')}\n  }`];
  if (options.meta !== undefined) fields.push(`"meta": ${JSON.stringify(options.meta, null, 2).replaceAll('\n', '\n  ')}`);
  const bytes = new TextEncoder().encode(`{\n  ${fields.join(',\n  ')}\n}\n`);
  await fs.writeFile(path.join(dir, SERVICE_PAYLOAD_MANIFEST), bytes, { flag: 'wx' });
  return bytes;
}
