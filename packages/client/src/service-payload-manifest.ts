import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
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

export async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

/**
 * Writes `byok-payload.json` for the payload in `dir` at build time (#1842)
 * and returns the bytes written. Every regular file is listed; a symlink or
 * other entry type, an existing manifest, an empty directory, an invalid id
 * and a `meta` that is not a JSON object throw.
 */
export async function writeServicePayloadManifest(dir: string, options: { id: string; meta?: JsonObject }): Promise<Uint8Array> {
  if (!VERSION_ID.test(options.id)) throw new TypeError(`Invalid payload id ${JSON.stringify(options.id)}: 1-64 of A-Z a-z 0-9 . _ -, starting with a letter or digit`);
  if (options.meta !== undefined && !isJsonObject(options.meta)) throw new TypeError('Payload manifest meta must be a JSON object');
  const relatives = await listPayloadFiles(dir, (relative) => new Error(`Payload entry ${relative} is not a regular file or directory`));
  if (relatives.includes(SERVICE_PAYLOAD_MANIFEST)) throw new Error(`${path.join(dir, SERVICE_PAYLOAD_MANIFEST)} already exists`);
  if (relatives.length === 0) throw new Error(`Payload directory ${dir} has no files`);
  const files: string[] = [];
  // Default sort compares UTF-16 code units, so the output does not depend on the file system's order or locale.
  for (const relative of relatives.sort()) {
    if (!isPayloadPath(relative)) throw new Error(`Payload path ${relative} cannot be listed in a manifest`);
    files.push(`    ${JSON.stringify(relative)}: "${await sha256File(path.join(dir, ...relative.split('/')))}"`);
  }
  // Written as text, not from an object: object key order puts integer-like paths ("9", "10") first.
  const fields = ['"format": "byok-service-payload"', '"version": 1', `"id": ${JSON.stringify(options.id)}`, `"files": {\n${files.join(',\n')}\n  }`];
  if (options.meta !== undefined) fields.push(`"meta": ${JSON.stringify(options.meta, null, 2).replaceAll('\n', '\n  ')}`);
  const bytes = new TextEncoder().encode(`{\n  ${fields.join(',\n  ')}\n}\n`);
  await fs.writeFile(path.join(dir, SERVICE_PAYLOAD_MANIFEST), bytes, { flag: 'wx' });
  return bytes;
}
