/**
 * Postgres {@link SkillPackStore} (plan `skill-pack-delivery-channel`, Phase 2).
 *
 * A faithful projection of {@link InMemorySkillPackStore}: same validators, same
 * refusals, same read shape. What `publish` checks and what it rejects is core's
 * decision, not this store's — it reuses `checkSkillPackManifest` /
 * `checkSkillPackEntry` and the manifest/file cross-checks the reference
 * performs, because this store cannot hash (integrity is the installing device's
 * job) but it CAN refuse to persist a pack whose declared path set or byte sizes
 * already disagree with the bytes it was handed. Storing that pair unchecked
 * would hand a device a corrupt publication it could not tell from a tampered
 * response.
 *
 * Two tables, one per level of the manifest (`deploy/sql/0005_skill_packs.sql`):
 * `skill_pack` carries the pack-level fields a `SkillPackManifest` needs to be
 * reconstructed (version, description, the pack content hash), and
 * `skill_pack_file` carries one row per declared file with its content hash,
 * byte size, and the UTF-8 text itself. A publish is a single transaction that
 * upserts the pack row and REPLACES its file set, so a re-publish of a changed
 * pack under the same name never leaves a stale file behind.
 *
 * `byte_size` is `integer`, not `bigint`: `SkillPackFile.byteSize` is a core
 * `number` bounded by `SKILL_PACK_FILE_MAX_BYTES` (256 KiB), unlike the quota
 * and truth byte fields the contract declares as `bigint`. `integer` is the
 * type that round-trips a `number` without a cast at the boundary — the same
 * call `object_manifest.ref_count` makes for a small count.
 *
 * No injected clock: a manifest carries no timestamp, so this store writes none
 * and asks the database for none. That mirrors the reference, which takes no
 * clock either.
 */
import {
  ByokCoreError,
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  checkSkillPackEntry,
  checkSkillPackManifest,
  type ContentHash,
  type SkillPackFile,
  type SkillPackFileContent,
  type SkillPackListQuery,
  type SkillPackManifest,
  type SkillPackPublishInput,
  type SkillPackStore,
  type TenantId,
} from '@byok-sdk/core';
import type { Pool, PoolClient } from 'pg';

const DEFAULT_LIST_LIMIT = 50;

interface PackRow {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly content_hash: string;
}

interface FileRow {
  readonly pack_name: string;
  readonly path: string;
  readonly content_hash: string;
  readonly byte_size: number;
  readonly content: string;
}

/** Reassembles the manifest a `publish` validated, from its two-level row set. */
function toManifest(pack: PackRow, files: readonly FileRow[]): SkillPackManifest {
  return {
    schema: SKILL_PACK_MANIFEST_SCHEMA_ID,
    name: pack.name,
    version: pack.version,
    description: pack.description,
    files: files.map(toFile),
    contentHash: pack.content_hash as ContentHash,
  };
}

function toFile(row: FileRow): SkillPackFile {
  return {
    path: row.path,
    contentHash: row.content_hash as ContentHash,
    byteSize: row.byte_size,
  };
}

export class PostgresSkillPackStore implements SkillPackStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async publish(tenant: TenantId, input: SkillPackPublishInput): Promise<SkillPackManifest> {
    const { manifest } = input;
    const structural = checkSkillPackManifest(manifest);
    if (!structural.ok) {
      throw new ByokCoreError(
        'skill_pack_manifest_invalid',
        `Refusing to publish ${JSON.stringify(manifest.name)}: ${structural.reason} — ${structural.detail}`,
      );
    }

    // The delivered path set and the declared path set must be exactly equal,
    // and every delivered file's UTF-8 byte length must equal its declared
    // size. Same checks the reference performs, in the same order, so a pack
    // rejected against one composition is rejected against the other.
    const contents = new Map<string, string>();
    for (const file of input.files) {
      if (contents.has(file.path)) {
        throw new ByokCoreError(
          'skill_pack_manifest_invalid',
          `Refusing to publish ${JSON.stringify(manifest.name)}: ${JSON.stringify(file.path)} was supplied twice.`,
        );
      }
      contents.set(file.path, file.content);
    }

    for (const declared of manifest.files) {
      const content = contents.get(declared.path);
      if (content === undefined) {
        throw new ByokCoreError(
          'skill_pack_manifest_invalid',
          `Refusing to publish ${JSON.stringify(manifest.name)}: ${JSON.stringify(declared.path)} is declared but was not supplied.`,
        );
      }
      const bytes = new TextEncoder().encode(content).length;
      if (bytes !== declared.byteSize) {
        throw new ByokCoreError(
          'skill_pack_manifest_invalid',
          `Refusing to publish ${JSON.stringify(manifest.name)}: ${JSON.stringify(declared.path)} declares ${declared.byteSize} bytes and supplies ${bytes}.`,
        );
      }
    }
    if (contents.size !== manifest.files.length) {
      throw new ByokCoreError(
        'skill_pack_manifest_invalid',
        `Refusing to publish ${JSON.stringify(manifest.name)}: ${contents.size} files were supplied for ${manifest.files.length} declared rows.`,
      );
    }

    const entry = checkSkillPackEntry(manifest, contents.get(SKILL_PACK_ENTRY_PATH)!);
    if (!entry.ok) {
      throw new ByokCoreError(
        'skill_pack_manifest_invalid',
        `Refusing to publish ${JSON.stringify(manifest.name)}: ${entry.reason} — ${entry.detail}`,
      );
    }

    await this.#inTransaction(async (client) => {
      await client.query(
        `INSERT INTO skill_pack (tenant_id, name, version, description, content_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, name) DO UPDATE
            SET version      = EXCLUDED.version,
                description  = EXCLUDED.description,
                content_hash = EXCLUDED.content_hash`,
        [tenant, manifest.name, manifest.version, manifest.description, manifest.contentHash],
      );
      // Replace, never merge: a re-publish under the same name is a full
      // overwrite, so a file dropped from the new manifest must not linger.
      await client.query(`DELETE FROM skill_pack_file WHERE tenant_id = $1 AND pack_name = $2`, [
        tenant,
        manifest.name,
      ]);
      for (const declared of manifest.files) {
        await client.query(
          `INSERT INTO skill_pack_file (tenant_id, pack_name, path, content_hash, byte_size, content)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            tenant,
            manifest.name,
            declared.path,
            declared.contentHash,
            declared.byteSize,
            contents.get(declared.path)!,
          ],
        );
      }
    });

    return manifest;
  }

  async get(tenant: TenantId, name: string): Promise<SkillPackManifest | undefined> {
    const packResult = await this.#pool.query<PackRow>(
      `SELECT name, version, description, content_hash
         FROM skill_pack WHERE tenant_id = $1 AND name = $2`,
      [tenant, name],
    );
    const pack = packResult.rows[0];
    if (pack === undefined) return undefined;

    const files = await this.#filesFor(tenant, [name]);
    return toManifest(pack, files);
  }

  async list(tenant: TenantId, query: SkillPackListQuery): Promise<readonly SkillPackManifest[]> {
    // Byte-order name sort, capped — the same order and default limit the
    // reference produces. `COLLATE "C"` pins it to code-point order rather than
    // the server's initialized collation.
    const packs = await this.#pool.query<PackRow>(
      `SELECT name, version, description, content_hash
         FROM skill_pack WHERE tenant_id = $1
        ORDER BY name COLLATE "C"
        LIMIT $2`,
      [tenant, query.limit ?? DEFAULT_LIST_LIMIT],
    );
    if (packs.rows.length === 0) return [];

    const files = await this.#filesFor(
      tenant,
      packs.rows.map((row) => row.name),
    );
    const byPack = new Map<string, FileRow[]>();
    for (const file of files) {
      const bucket = byPack.get(file.pack_name);
      if (bucket === undefined) byPack.set(file.pack_name, [file]);
      else bucket.push(file);
    }
    return packs.rows.map((pack) => toManifest(pack, byPack.get(pack.name) ?? []));
  }

  async readFile(
    tenant: TenantId,
    name: string,
    path: string,
  ): Promise<SkillPackFileContent | undefined> {
    const result = await this.#pool.query<FileRow>(
      `SELECT pack_name, path, content_hash, byte_size, content
         FROM skill_pack_file
        WHERE tenant_id = $1 AND pack_name = $2 AND path = $3`,
      [tenant, name, path],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      path: row.path,
      contentHash: row.content_hash as ContentHash,
      byteSize: row.byte_size,
      content: row.content,
    };
  }

  /** Every file row for the named packs, in byte order of (pack_name, path). */
  async #filesFor(tenant: TenantId, names: readonly string[]): Promise<FileRow[]> {
    const result = await this.#pool.query<FileRow>(
      `SELECT pack_name, path, content_hash, byte_size, content
         FROM skill_pack_file
        WHERE tenant_id = $1 AND pack_name = ANY($2::text[])
        ORDER BY pack_name COLLATE "C", path COLLATE "C"`,
      [tenant, names],
    );
    return result.rows;
  }

  async #inTransaction(run: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await run(client);
      await client.query('COMMIT');
    } catch (error) {
      // Best-effort rollback, for the same reason the object store's is: a
      // rollback that itself throws must not replace the failure the caller
      // needs to see.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
