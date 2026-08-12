/**
 * Skill-pack conformance (plan `skill-pack-delivery-channel`, Phase 2).
 *
 * One assertion source, every composition. `skillPacks` became a mandatory
 * `CoreStores` member in Phase 2, so the port-inventory dimension already forces
 * every composition to supply it; this group asserts it BEHAVES the same in
 * memory and on Postgres — a pack round-trips through publish → get → list →
 * readFile with identical bytes, a re-publish replaces rather than merges, the
 * shared validators refuse the same malformed publication, and nothing one
 * tenant published is visible to another.
 *
 * The fixtures use fake-but-well-formed content hashes: this store is not the
 * integrity authority (core has no crypto — the installing device re-derives and
 * verifies every address), so publish checks the declared path set, the byte
 * sizes, and the entry frontmatter name, none of which need a real digest.
 */
import { describe, expect, it } from 'vitest';
import {
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  isCoreError,
  parseSkillPackManifest,
  type SkillPackManifest,
} from '@byok-sdk/core';
import { hashOf, TENANT_A, TENANT_B } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

const NESTED_PATH = 'references/ledger.md';
const NESTED_TEXT = '# Ledger reference\n';

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A `SKILL.md` whose frontmatter name matches the pack — publish rejects a mismatch. */
function entryText(name: string): string {
  return ['---', `name: ${name}`, 'description: A packaged skill.', '---', '', 'Body.', ''].join(
    '\n',
  );
}

interface Pack {
  readonly manifest: SkillPackManifest;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/**
 * A two-file pack for `name`. Files are declared in byte order of their paths
 * (`SKILL.md` sorts before `references/ledger.md`), which is the order a
 * composition's `get` must return them in — the in-memory reference preserves
 * publication order and the Postgres store sorts by path, so a sorted
 * publication is the one both agree on.
 */
function makePack(name: string): Pack {
  const entry = entryText(name);
  const addressed = {
    name,
    version: '1.0.0',
    description: 'A packaged skill.',
    files: [
      { path: SKILL_PACK_ENTRY_PATH, contentHash: hashOf(1) as string, byteSize: byteLength(entry) },
      { path: NESTED_PATH, contentHash: hashOf(2) as string, byteSize: byteLength(NESTED_TEXT) },
    ],
  };
  const manifest = parseSkillPackManifest({
    schema: SKILL_PACK_MANIFEST_SCHEMA_ID,
    ...addressed,
    contentHash: hashOf(3) as string,
  });
  return {
    manifest,
    files: [
      { path: SKILL_PACK_ENTRY_PATH, content: entry },
      { path: NESTED_PATH, content: NESTED_TEXT },
    ],
  };
}

export function runSkillPackConformance(factory: CoreCompositionFactory): void {
  describe('skill packs', () => {
    it('round-trips a published pack through get, list, and readFile', async () => {
      await withComposition(factory, async ({ stores }) => {
        const pack = makePack('long-task-git-workflow');
        const published = await stores.skillPacks.publish(TENANT_A, pack);
        expect(published).toEqual(pack.manifest);

        const got = await stores.skillPacks.get(TENANT_A, 'long-task-git-workflow');
        expect(got).toEqual(pack.manifest);

        const list = await stores.skillPacks.list(TENANT_A, {});
        expect(list).toEqual([pack.manifest]);

        const entry = await stores.skillPacks.readFile(
          TENANT_A,
          'long-task-git-workflow',
          SKILL_PACK_ENTRY_PATH,
        );
        expect(entry).toEqual({
          path: SKILL_PACK_ENTRY_PATH,
          contentHash: pack.manifest.files[0]!.contentHash,
          byteSize: pack.manifest.files[0]!.byteSize,
          content: pack.files[0]!.content,
        });

        const nested = await stores.skillPacks.readFile(
          TENANT_A,
          'long-task-git-workflow',
          NESTED_PATH,
        );
        expect(nested?.content).toBe(NESTED_TEXT);
      });
    });

    it('returns undefined for a missing pack and a missing file alike', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.skillPacks.publish(TENANT_A, makePack('long-task-git-workflow'));

        expect(await stores.skillPacks.get(TENANT_A, 'no-such-pack')).toBeUndefined();
        expect(
          await stores.skillPacks.readFile(TENANT_A, 'long-task-git-workflow', 'references/missing.md'),
        ).toBeUndefined();
        expect(
          await stores.skillPacks.readFile(TENANT_A, 'no-such-pack', SKILL_PACK_ENTRY_PATH),
        ).toBeUndefined();
      });
    });

    it('lists a tenant’s packs in name order, capped by the limit', async () => {
      await withComposition(factory, async ({ stores }) => {
        // Publish out of order to prove the store sorts rather than the caller.
        await stores.skillPacks.publish(TENANT_A, makePack('zeta-pack'));
        await stores.skillPacks.publish(TENANT_A, makePack('alpha-pack'));
        await stores.skillPacks.publish(TENANT_A, makePack('mid-pack'));

        const all = await stores.skillPacks.list(TENANT_A, {});
        expect(all.map((manifest) => manifest.name)).toEqual(['alpha-pack', 'mid-pack', 'zeta-pack']);

        const capped = await stores.skillPacks.list(TENANT_A, { limit: 2 });
        expect(capped.map((manifest) => manifest.name)).toEqual(['alpha-pack', 'mid-pack']);
      });
    });

    it('replaces a pack on re-publish rather than merging its files', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.skillPacks.publish(TENANT_A, makePack('long-task-git-workflow'));

        // A second publication under the same name that carries only the entry
        // file must drop the nested file the first one had.
        const entry = entryText('long-task-git-workflow');
        const addressed = {
          name: 'long-task-git-workflow',
          version: '2.0.0',
          description: 'A packaged skill.',
          files: [
            {
              path: SKILL_PACK_ENTRY_PATH,
              contentHash: hashOf(1) as string,
              byteSize: byteLength(entry),
            },
          ],
        };
        const manifest = parseSkillPackManifest({
          schema: SKILL_PACK_MANIFEST_SCHEMA_ID,
          ...addressed,
          contentHash: hashOf(4) as string,
        });
        await stores.skillPacks.publish(TENANT_A, {
          manifest,
          files: [{ path: SKILL_PACK_ENTRY_PATH, content: entry }],
        });

        const got = await stores.skillPacks.get(TENANT_A, 'long-task-git-workflow');
        expect(got).toEqual(manifest);
        expect(got?.version).toBe('2.0.0');
        expect(
          await stores.skillPacks.readFile(TENANT_A, 'long-task-git-workflow', NESTED_PATH),
        ).toBeUndefined();
      });
    });

    it('refuses a publish whose delivered bytes disagree with the manifest', async () => {
      await withComposition(factory, async ({ stores }) => {
        const pack = makePack('long-task-git-workflow');
        // Same manifest, but the entry file's bytes are one longer than declared.
        const tampered = {
          manifest: pack.manifest,
          files: [
            { path: SKILL_PACK_ENTRY_PATH, content: `${pack.files[0]!.content} ` },
            { path: NESTED_PATH, content: NESTED_TEXT },
          ],
        };
        const error = await stores.skillPacks
          .publish(TENANT_A, tampered)
          .then(() => undefined, (caught: unknown) => caught);
        expect(isCoreError(error, 'skill_pack_manifest_invalid')).toBe(true);

        // Nothing partial was left behind.
        expect(await stores.skillPacks.get(TENANT_A, 'long-task-git-workflow')).toBeUndefined();
      });
    });

    it('keeps one tenant’s packs invisible to another', async () => {
      await withComposition(factory, async ({ stores }) => {
        await stores.skillPacks.publish(TENANT_A, makePack('long-task-git-workflow'));

        expect(await stores.skillPacks.get(TENANT_B, 'long-task-git-workflow')).toBeUndefined();
        expect(await stores.skillPacks.list(TENANT_B, {})).toEqual([]);
        expect(
          await stores.skillPacks.readFile(TENANT_B, 'long-task-git-workflow', SKILL_PACK_ENTRY_PATH),
        ).toBeUndefined();
      });
    });
  });
}
