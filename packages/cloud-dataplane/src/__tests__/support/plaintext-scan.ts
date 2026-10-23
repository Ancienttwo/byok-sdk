/**
 * The canary scan of the hosted plaintext inventory (#654 S0-b), shared by the
 * inventory test and the redaction tests (#654 E5a).
 *
 * The table list comes from `pg_class` with the query that tenant erasure
 * runs (`PostgresTenantErasure#assertSchemaInventory` in `tenant-erasure.ts`),
 * not from a constant. A new table is scanned as soon as a migration adds it.
 */
import type { Pool } from 'pg';
import type { ObjectStorageScope } from './dataplane';

/** The query tenant erasure runs to find every tenant table (`tenant-erasure.ts`). */
export const TENANT_TABLES_SQL = `SELECT t.relname
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relkind = 'r'
          AND t.relname NOT IN ('byok_schema_migration', 'tenant_erasure_operation')
        ORDER BY t.relname`;

export interface Needle {
  readonly form: string;
  readonly text: string;
  readonly bytes: Buffer;
}

/** Location (`table.column`, `r2:<key pattern>` or `log:console`) to the canary forms found there. */
export type Hits = Map<string, Set<string>>;

/**
 * The base64 text that every encoding of `bytes` contains when they start
 * `offset` bytes after a 3-byte boundary. The characters that also encode a
 * neighbouring byte are dropped at both ends.
 */
function alignedBase64(bytes: Buffer, offset: number, encoding: 'base64' | 'base64url'): string {
  const shifted = Buffer.concat([Buffer.alloc(offset), bytes]);
  return shifted.toString(encoding).slice(offset === 0 ? 0 : 4, Math.floor(shifted.length / 3) * 4);
}

/**
 * The forms the scan looks for. The text forms show how a column keeps the
 * canary. The core and its binary forms also find a copy that was escaped
 * before it was hex- or base64-encoded. `core` must need no JSON escaping.
 */
export function canaryNeedles(core: string, canary: string): readonly Needle[] {
  const coreBytes = Buffer.from(core, 'utf8');
  const forms: (readonly [string, string])[] = [
    ['utf-8', canary],
    ['json-escaped', JSON.stringify(canary).slice(1, -1)],
    ['core', core],
    ['hex', coreBytes.toString('hex')],
  ];
  for (const offset of [0, 1, 2]) {
    forms.push([`base64+${offset}`, alignedBase64(coreBytes, offset, 'base64')]);
    forms.push([`base64url+${offset}`, alignedBase64(coreBytes, offset, 'base64url')]);
  }
  return forms.map(([form, text]) => ({ form, text, bytes: Buffer.from(text, 'utf8') }));
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function record(hits: Hits, location: string, value: unknown, needles: readonly Needle[]): void {
  for (const needle of needles) {
    const found = Buffer.isBuffer(value)
      ? value.includes(needle.bytes)
      : typeof value === 'string' && value.includes(needle.text);
    if (!found) continue;
    const forms = hits.get(location) ?? new Set<string>();
    forms.add(needle.form);
    hits.set(location, forms);
  }
}

export interface TenantRow {
  readonly table: string;
  readonly columns: readonly string[];
  readonly values: readonly unknown[];
}

/** Every row of every tenant table, each column as text or, for `bytea`, as bytes. */
export async function readTenantRows(pool: Pool): Promise<{ readonly tables: number; readonly rows: readonly TenantRow[] }> {
  const tables = await pool.query<{ readonly relname: string }>(TENANT_TABLES_SQL);
  const rows: TenantRow[] = [];
  for (const { relname: table } of tables.rows) {
    const columns = await pool.query<{ readonly name: string; readonly bytes: boolean }>(
      `SELECT a.attname AS name, a.atttypid = 'bytea'::regtype AS bytes
         FROM pg_attribute a
         JOIN pg_class t ON t.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema() AND t.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [table],
    );
    const select = columns.rows
      .map((column, index) => `${quoteIdent(column.name)}${column.bytes ? '' : '::text'} AS c${index}`)
      .join(', ');
    const result = await pool.query<Record<string, unknown>>(`SELECT ${select} FROM ${quoteIdent(table)}`);
    const names = columns.rows.map((column) => column.name);
    for (const row of result.rows) rows.push({ table, columns: names, values: names.map((_, index) => row[`c${index}`]) });
  }
  return { tables: tables.rows.length, rows };
}

/** Every column of every tenant table. Returns the number of tables scanned. */
export async function scanPostgres(pool: Pool, needles: readonly Needle[], hits: Hits): Promise<number> {
  const { tables, rows } = await readTenantRows(pool);
  for (const row of rows) {
    row.values.forEach((value, index) => record(hits, `${row.table}.${row.columns[index]}`, value, needles));
  }
  return tables;
}

/** The key with the tenant and the content hash replaced by placeholders. */
export function objectLocation(key: string, tenant: string): string {
  const parts = key.split('/');
  if (parts.length === 5 && parts[0] === 'tenants' && parts[1] === tenant && /^[0-9a-f]{64}$/u.test(parts[4] ?? '')) {
    return `r2:tenants/<tenant>/${parts[2]}/${parts[3]}/<hex>`;
  }
  return `r2:${key}`;
}

/** Every object in the bucket, listed with ListObjectsV2. The bucket is the test's own. */
export async function readObjects(storage: ObjectStorageScope): Promise<ReadonlyMap<string, Buffer>> {
  const bucketUrl = `${storage.config.endpoint}/${storage.bucket}`;
  const keys: string[] = [];
  let continuation: string | undefined;
  do {
    const query = new URLSearchParams({ 'list-type': '2' });
    if (continuation !== undefined) query.set('continuation-token', continuation);
    const listed = await storage.client.fetch(`${bucketUrl}?${query.toString()}`);
    const xml = await listed.text();
    if (!listed.ok) throw new Error(`ListObjectsV2 failed: HTTP ${listed.status} ${xml}`);
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/gu)].map((match) => match[1]!));
    continuation = /<IsTruncated>true<\/IsTruncated>/u.test(xml)
      ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u.exec(xml)?.[1]
      : undefined;
  } while (continuation !== undefined);
  const objects = new Map<string, Buffer>();
  for (const key of keys) {
    const object = await storage.client.fetch(`${bucketUrl}/${key}`);
    if (!object.ok) throw new Error(`GET ${key} failed: HTTP ${object.status}`);
    objects.set(key, Buffer.from(await object.arrayBuffer()));
  }
  return objects;
}

/** Every object in the bucket. Returns the number of objects scanned. */
export async function scanObjects(
  storage: ObjectStorageScope,
  tenant: string,
  needles: readonly Needle[],
  hits: Hits,
): Promise<number> {
  const objects = await readObjects(storage);
  for (const [key, bytes] of objects) record(hits, objectLocation(key, tenant), bytes, needles);
  return objects.size;
}
