-- 0005_skill_packs.sql — the core.skillPacks port tables.
--
-- Forward-only, like every migration before it (sprint S4A.6): a correction is
-- a NEW file, never an edit to this one, and the runner checksums every applied
-- file against its ledger row (packages/cloud-postgres/src/migrate.ts). 0001
-- through 0004 are untouched here.
--
-- Phase 2 of the skill-pack-delivery-channel plan promotes `skillPacks` from a
-- bridge port to a mandatory `CoreStores` member, so every Postgres deployment
-- creates these tables. They are empty on a deployment that never declares the
-- `skills.pack` capability — storage presence is not capability advertisement.
--
-- The type discipline of 0002 applies:
--
--   EVERY unique index or constraint on a tenant-owned table starts with
--   tenant_id.
--
-- Both primary keys below start with tenant_id, and this file adds no exception
-- to the two-entry whitelist 0001 owns.
--
-- ---------------------------------------------------------------------------
-- skill_pack (core.skillPacks) — one row per published pack
-- ---------------------------------------------------------------------------
--
-- The pack-level fields a `SkillPackManifest` needs to be reconstructed on read:
-- `version` orders two publications of one name, `description` is the catalogue
-- text, and `content_hash` is the manifest's whole-pack content address (the
-- installer re-derives and verifies it; this store never hashes). The schema id
-- is a constant the store supplies from `SKILL_PACK_MANIFEST_SCHEMA_ID` rather
-- than a stored column, so it cannot drift per row.
--
-- PK (tenant_id, name): a pack name is unique within a tenant and a re-publish
-- under the same name replaces the pack, which is the store's idempotent upsert.
-- Never (name) alone — a global name space would turn pack existence into a
-- cross-tenant oracle, the same call object_manifest makes for content hashes.
--
-- No stored timestamp: the manifest carries none, so the store writes none and
-- reads the database clock nowhere.
CREATE TABLE skill_pack (
  tenant_id    text NOT NULL,
  name         text NOT NULL,
  version      text NOT NULL,
  description  text NOT NULL,
  content_hash text NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

-- ---------------------------------------------------------------------------
-- skill_pack_file (core.skillPacks) — one row per declared file
-- ---------------------------------------------------------------------------
--
-- Each file the pack declares, with the metadata the manifest addresses it by
-- (`content_hash`, `byte_size`) and the UTF-8 text itself (`content`). A pack
-- carries Markdown, YAML and static text assets — never binaries, never
-- archives — so `content` is `text`, not `bytea`: it stores exactly the string
-- `SkillPackFileContent.content` is typed as and hands the wire handler back
-- byte for byte.
--
-- `byte_size` is `integer`, not `bigint`. `SkillPackFile.byteSize` is a core
-- `number` bounded by SKILL_PACK_FILE_MAX_BYTES (256 KiB), unlike the quota and
-- truth byte fields the contract declares as `bigint` (and that the pool's int8
-- parser therefore decodes as `BigInt`). `integer` decodes to a JS `number`
-- with no cast at the boundary — the same call 0002 makes for the small
-- integer row counts (`rev`, `ref_count`).
--
-- PK (tenant_id, pack_name, path): a path is unique within a pack, and the
-- reference store's publish rejects a duplicate path before it reaches here.
-- The publish replaces the whole file set in one transaction (DELETE then
-- INSERT), so a re-publish that drops a file leaves no orphan row behind.
CREATE TABLE skill_pack_file (
  tenant_id    text    NOT NULL,
  pack_name    text    NOT NULL,
  path         text    NOT NULL,
  content_hash text    NOT NULL,
  byte_size    integer NOT NULL,
  content      text    NOT NULL,
  PRIMARY KEY (tenant_id, pack_name, path)
);
