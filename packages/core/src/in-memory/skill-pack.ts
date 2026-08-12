/**
 * In-memory {@link SkillPackStore} reference (plan `skill-pack-delivery-channel`).
 *
 * The interesting property is what `publish` refuses. This store cannot hash —
 * core has no crypto — so it is NOT the integrity authority for a pack, and it
 * does not pretend to be: the publisher mints the addresses and the installing
 * device re-derives and verifies every one of them. What this store CAN check
 * without crypto, it checks, and rejects rather than storing a pack whose
 * manifest and bytes already disagree at publish time: the declared path set
 * must be exactly the delivered path set, and every delivered file's UTF-8 byte
 * length must equal what its row declared.
 *
 * Storing that pair unchecked would be the worse failure mode by far — the
 * device would fetch, verify, reject, and have no way to tell a corrupt
 * publication from a tampered response.
 */
import {
  SKILL_PACK_ENTRY_PATH,
  checkSkillPackEntry,
  checkSkillPackManifest,
  type SkillPackFileContent,
  type SkillPackListQuery,
  type SkillPackManifest,
  type SkillPackPublishInput,
  type SkillPackStore,
} from '../skill-pack';
import { ByokCoreError } from '../errors';
import { tenantKey, type TenantId } from '../tenant';

const DEFAULT_LIST_LIMIT = 50;

interface StoredPack {
  readonly manifest: SkillPackManifest;
  readonly contents: ReadonlyMap<string, string>;
}

export class InMemorySkillPackStore implements SkillPackStore {
  readonly #packs = new Map<string, StoredPack>();

  async publish(tenant: TenantId, input: SkillPackPublishInput): Promise<SkillPackManifest> {
    const { manifest } = input;
    const structural = checkSkillPackManifest(manifest);
    if (!structural.ok) {
      throw new ByokCoreError(
        'skill_pack_manifest_invalid',
        `Refusing to publish ${JSON.stringify(manifest.name)}: ${structural.reason} — ${structural.detail}`,
      );
    }

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

    this.#packs.set(tenantKey(tenant, manifest.name), { manifest, contents });
    return manifest;
  }

  async get(tenant: TenantId, name: string): Promise<SkillPackManifest | undefined> {
    return this.#packs.get(tenantKey(tenant, name))?.manifest;
  }

  async list(tenant: TenantId, query: SkillPackListQuery): Promise<readonly SkillPackManifest[]> {
    const prefix = tenantKey(tenant, '');
    const manifests: SkillPackManifest[] = [];
    for (const [key, pack] of this.#packs.entries()) {
      if (!key.startsWith(prefix)) continue;
      manifests.push(pack.manifest);
    }
    manifests.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return manifests.slice(0, query.limit ?? DEFAULT_LIST_LIMIT);
  }

  async readFile(
    tenant: TenantId,
    name: string,
    path: string,
  ): Promise<SkillPackFileContent | undefined> {
    const pack = this.#packs.get(tenantKey(tenant, name));
    if (pack === undefined) return undefined;
    const declared = pack.manifest.files.find((file) => file.path === path);
    const content = pack.contents.get(path);
    if (declared === undefined || content === undefined) return undefined;
    return {
      path: declared.path,
      contentHash: declared.contentHash,
      byteSize: declared.byteSize,
      content,
    };
  }
}
