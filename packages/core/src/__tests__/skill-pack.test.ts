/**
 * The skill-pack contract, made falsifiable.
 *
 * Structured around one rule from the plan: every DECLARED limit ships with the
 * code that evaluates it and a test that proves the rejection path fires. A cap
 * nothing measures and a path rule nothing checks look identical in a green
 * suite, so each limit below has a negative case that is only green because
 * something refused.
 */
import { describe, expect, it } from 'vitest';
import {
  SKILL_PACK_DESCRIPTION_MAX_LENGTH,
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_FILE_MAX_BYTES,
  SKILL_PACK_FORBIDDEN_FIELDS,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  SKILL_PACK_MAX_FILES,
  SKILL_PACK_NAME_MAX_LENGTH,
  SkillPackManifestSchema,
  checkSkillPackEntry,
  checkSkillPackFileContent,
  checkSkillPackManifest,
  contentHash,
  isSkillPackPathSafe,
  parseSkillFrontmatter,
  parseSkillPackManifest,
  skillPackContentHashInput,
  tenantId,
  type SkillPackFile,
  type SkillPackManifest,
} from '../index';
import { InMemorySkillPackStore } from '../in-memory/index';

const TENANT = tenantId('tenant-skill-packs');

function hashOf(seed: string): ReturnType<typeof contentHash> {
  // A fixed-shape stand-in: this package has no crypto, and every assertion
  // below is about the COMPARISON, never about the digest function.
  const hex = seed.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');
  return contentHash(`sha256:${hex}`);
}

const ENTRY_TEXT = ['---', 'name: long-task-git-workflow', 'description: Manage a long task.', '---', '', 'Body.', ''].join('\n');

function file(path: string, content: string): SkillPackFile {
  return {
    path,
    contentHash: hashOf(path.replace(/[^0-9a-f]/g, '')),
    byteSize: new TextEncoder().encode(content).length,
  };
}

function manifest(overrides: Partial<SkillPackManifest> = {}): SkillPackManifest {
  const files = overrides.files ?? [file(SKILL_PACK_ENTRY_PATH, ENTRY_TEXT)];
  const base = {
    schema: SKILL_PACK_MANIFEST_SCHEMA_ID,
    name: 'long-task-git-workflow',
    version: '1.0.0',
    description: 'Manage a long task.',
    ...overrides,
    files,
  } as const;
  return { ...base, contentHash: overrides.contentHash ?? hashOf('cafe') } as SkillPackManifest;
}

describe('manifest schema', () => {
  it('accepts a well-formed manifest', () => {
    const parsed = parseSkillPackManifest(JSON.parse(JSON.stringify(manifest())));
    expect(parsed.name).toBe('long-task-git-workflow');
    expect(parsed.files).toHaveLength(1);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    const input = { ...JSON.parse(JSON.stringify(manifest())), somethingNew: true };
    expect(() => parseSkillPackManifest(input)).toThrowError(
      expect.objectContaining({ code: 'skill_pack_manifest_invalid' }),
    );
  });

  it.each([...SKILL_PACK_FORBIDDEN_FIELDS])('refuses a manifest carrying %s', (field) => {
    const input = { ...JSON.parse(JSON.stringify(manifest())), [field]: 'anything' };
    expect(() => parseSkillPackManifest(input)).toThrowError(
      expect.objectContaining({ code: 'skill_pack_manifest_invalid' }),
    );
    // Named, not merely "unrecognized key": the rejection has to say what it
    // refused, or an operator cannot tell a typo from a credential leak.
    expect(() => parseSkillPackManifest(input)).toThrowError(new RegExp(field.replace(/[-]/g, '\\-')));
  });

  it('has no exec, env, or credential field ANYWHERE in the schema shape', () => {
    // The constraint stated positively: the manifest's key set is exactly these
    // six names. A future field lands here as a failing test, which is the only
    // way "no executable surface" stays a property rather than a memory.
    const shape = Object.keys(SkillPackManifestSchema.shape).sort();
    expect(shape).toEqual(['contentHash', 'description', 'files', 'name', 'schema', 'version']);
    for (const forbidden of SKILL_PACK_FORBIDDEN_FIELDS) {
      expect(shape).not.toContain(forbidden);
    }
  });

  it.each([
    ['UPPERCASE', 'Long-Task'],
    ['a leading dot', '.hidden'],
    ['a slash', 'vendor/pack'],
    ['a space', 'long task'],
    ['over the length cap', 'a'.repeat(SKILL_PACK_NAME_MAX_LENGTH + 1)],
  ])('rejects a name with %s', (_label, name) => {
    expect(() => parseSkillPackManifest({ ...JSON.parse(JSON.stringify(manifest())), name })).toThrow();
  });

  it('rejects an over-long description', () => {
    const description = 'x'.repeat(SKILL_PACK_DESCRIPTION_MAX_LENGTH + 1);
    expect(() => parseSkillPackManifest({ ...JSON.parse(JSON.stringify(manifest())), description })).toThrow();
  });

  it('rejects a non-semver version and an empty file list', () => {
    expect(() => parseSkillPackManifest({ ...JSON.parse(JSON.stringify(manifest())), version: 'latest' })).toThrow();
    expect(() => parseSkillPackManifest({ ...JSON.parse(JSON.stringify(manifest())), files: [] })).toThrow();
  });

  it('rejects a content hash that is not sha256:<64 lowercase hex>', () => {
    for (const bad of ['sha256:ABC', 'sha1:' + 'a'.repeat(40), 'a'.repeat(64), `sha256:${'A'.repeat(64)}`]) {
      expect(() => parseSkillPackManifest({ ...JSON.parse(JSON.stringify(manifest())), contentHash: bad })).toThrow();
    }
  });
});

describe('path safety', () => {
  it.each([
    ['a parent-directory hop', '../etc/passwd'],
    ['a nested parent-directory hop', 'docs/../../etc/passwd'],
    ['a bare parent segment', '..'],
    ['an absolute posix path', '/etc/passwd'],
    ['a windows absolute path', 'C:/Windows/system32'],
    ['a UNC path', '\\\\host\\share'],
    ['a backslash separator', 'docs\\guide.md'],
    ['a home-relative path', '~/.ssh/authorized_keys'],
    ['an empty segment', 'docs//guide.md'],
    ['a trailing slash', 'docs/'],
    ['a dotfile', '.env'],
    ['a nested dotfile', 'docs/.env'],
    ['a NUL byte', 'docs/guide\u0000.md'],
    ['a newline', 'docs/guide\n.md'],
  ])('refuses %s', (_label, path) => {
    expect(isSkillPackPathSafe(path)).toBe(false);
    expect(
      parseSkillPackManifest.bind(null, {
        ...JSON.parse(JSON.stringify(manifest())),
        files: [{ ...JSON.parse(JSON.stringify(file(SKILL_PACK_ENTRY_PATH, ENTRY_TEXT))), path }],
      }),
    ).toThrow();
  });

  it('accepts an ordinary relative path and the entry file', () => {
    expect(isSkillPackPathSafe(SKILL_PACK_ENTRY_PATH)).toBe(true);
    expect(isSkillPackPathSafe('references/git-ledger.md')).toBe(true);
  });

  it('refuses a traversal path at the byte gate too, not only at parse time', () => {
    // Defense in depth: the byte-level check re-evaluates the path, so a caller
    // that built a `SkillPackFile` some other way still cannot write outside.
    const declared = { ...file('docs/guide.md', 'x'), path: '../escape.md' } as SkillPackFile;
    const check = checkSkillPackFileContent(declared, {
      byteSize: declared.byteSize,
      contentHash: declared.contentHash,
    });
    expect(check).toEqual({ ok: false, reason: 'path-unsafe', detail: expect.any(String) });
  });
});

describe('manifest-level limits', () => {
  it('accepts a manifest whose files agree', () => {
    const check = checkSkillPackManifest(manifest());
    expect(check.ok).toBe(true);
  });

  it('refuses a pack with no SKILL.md', () => {
    const check = checkSkillPackManifest(manifest({ files: [file('docs/guide.md', 'hello')] }));
    expect(check).toMatchObject({ ok: false, reason: 'entry-missing' });
  });

  it('refuses a duplicate path', () => {
    const entry = file(SKILL_PACK_ENTRY_PATH, ENTRY_TEXT);
    const check = checkSkillPackManifest(manifest({ files: [entry, entry] }));
    expect(check).toMatchObject({ ok: false, reason: 'duplicate-path' });
  });

  it('refuses a pack whose declared bytes exceed the pack cap', () => {
    const files: SkillPackFile[] = [file(SKILL_PACK_ENTRY_PATH, ENTRY_TEXT)];
    for (let index = 0; index < 8; index += 1) {
      files.push({
        path: `docs/part${index}.md`,
        contentHash: hashOf(`d${index}`),
        byteSize: SKILL_PACK_FILE_MAX_BYTES,
      });
    }
    const check = checkSkillPackManifest(manifest({ files }));
    expect(check).toMatchObject({ ok: false, reason: 'pack-over-cap' });
  });

  it('refuses more files than the count cap allows', () => {
    const files = Array.from({ length: SKILL_PACK_MAX_FILES + 1 }, (_value, index) => ({
      path: `docs/part${index}.md`,
      contentHash: hashOf(`c${index}`),
      byteSize: 1,
    }));
    // The count cap is enforced by the schema as well as by the check — so both
    // the parse path and a hand-built manifest hit it.
    expect(() => parseSkillPackManifest({ ...JSON.parse(JSON.stringify(manifest())), files })).toThrow();
    expect(checkSkillPackManifest(manifest({ files }))).toMatchObject({
      ok: false,
      reason: 'file-count-over-cap',
    });
  });

  it('refuses a per-file declaration over the file cap', () => {
    expect(() =>
      parseSkillPackManifest({
        ...JSON.parse(JSON.stringify(manifest())),
        files: [
          { ...JSON.parse(JSON.stringify(file(SKILL_PACK_ENTRY_PATH, ENTRY_TEXT))), byteSize: SKILL_PACK_FILE_MAX_BYTES + 1 },
        ],
      }),
    ).toThrow();
  });
});

describe('byte-level limits', () => {
  const declared = file('docs/guide.md', 'hello');

  it('accepts bytes that match the declaration', () => {
    expect(
      checkSkillPackFileContent(declared, { byteSize: declared.byteSize, contentHash: declared.contentHash }),
    ).toEqual({ ok: true, bytes: declared.byteSize });
  });

  it('refuses a size the declaration did not promise', () => {
    expect(
      checkSkillPackFileContent(declared, { byteSize: declared.byteSize + 1, contentHash: declared.contentHash }),
    ).toMatchObject({ ok: false, reason: 'size-mismatch' });
  });

  it('refuses bytes whose hash disagrees', () => {
    expect(
      checkSkillPackFileContent(declared, { byteSize: declared.byteSize, contentHash: hashOf('beef') }),
    ).toMatchObject({ ok: false, reason: 'hash-mismatch' });
  });

  it('enforces the file cap on the OBSERVED size, not the declared one', () => {
    // The whole point: a small declaration attached to a huge response must not
    // pass. `size-mismatch` would also fire here, so the assertion is that the
    // CAP fires first — the check must not admit the bytes long enough to
    // compare them.
    const understated: SkillPackFile = { ...declared, byteSize: 5 };
    expect(
      checkSkillPackFileContent(understated, {
        byteSize: SKILL_PACK_FILE_MAX_BYTES + 1,
        contentHash: declared.contentHash,
      }),
    ).toMatchObject({ ok: false, reason: 'file-over-cap' });
  });
});

describe('content hash input', () => {
  it('is order-independent over the file list', () => {
    const a = file('docs/a.md', 'a');
    const b = file('docs/b.md', 'bb');
    const entry = file(SKILL_PACK_ENTRY_PATH, ENTRY_TEXT);
    expect(skillPackContentHashInput(manifest({ files: [entry, a, b] }))).toBe(
      skillPackContentHashInput(manifest({ files: [b, entry, a] })),
    );
  });

  it('changes when any addressed field changes', () => {
    const base = skillPackContentHashInput(manifest());
    expect(skillPackContentHashInput(manifest({ version: '1.0.1' }))).not.toBe(base);
    expect(skillPackContentHashInput(manifest({ description: 'Something else.' }))).not.toBe(base);
    expect(
      skillPackContentHashInput(manifest({ files: [file(SKILL_PACK_ENTRY_PATH, `${ENTRY_TEXT}extra`)] })),
    ).not.toBe(base);
  });

  it('cannot be forged by shifting a description across the field boundary', () => {
    // The length prefix is why: without it, a description ending in a newline
    // could impersonate the field that follows it.
    expect(skillPackContentHashInput(manifest({ description: 'a\n1' }))).not.toBe(
      skillPackContentHashInput(manifest({ description: 'a', version: '1.0.0' })),
    );
  });
});

describe('SKILL.md frontmatter', () => {
  it('accepts the agentskills.io shape', () => {
    expect(parseSkillFrontmatter(ENTRY_TEXT)).toEqual({
      name: 'long-task-git-workflow',
      description: 'Manage a long task.',
    });
  });

  it('accepts quoted values', () => {
    const text = ['---', 'name: "pack-a"', "description: 'It does a thing.'", '---', 'body'].join('\n');
    expect(parseSkillFrontmatter(text)).toEqual({ name: 'pack-a', description: 'It does a thing.' });
  });

  it.each([
    ['no opening delimiter', 'name: pack-a\ndescription: x\n'],
    ['no closing delimiter', '---\nname: pack-a\ndescription: x\n'],
    ['a missing name', '---\ndescription: x\n---\n'],
    ['a missing description', '---\nname: pack-a\n---\n'],
    ['a duplicate key', '---\nname: pack-a\nname: pack-b\ndescription: x\n---\n'],
    ['an empty value', '---\nname: pack-a\ndescription:\n---\n'],
    ['a non key: value line', '---\nname: pack-a\ndescription: x\n- listy\n---\n'],
    ['a nested map', '---\nname: pack-a\ndescription: x\nmetadata:\n  a: b\n---\n'],
    ['an invalid name', '---\nname: Pack A\ndescription: x\n---\n'],
  ])('refuses frontmatter with %s', (_label, text) => {
    expect(() => parseSkillFrontmatter(text)).toThrowError(
      expect.objectContaining({ code: 'skill_pack_frontmatter_invalid' }),
    );
  });

  it.each(['allowed-tools: Bash', 'hooks: ./setup.sh', 'env: PATH', 'license: MIT'])(
    'refuses the out-of-contract frontmatter key in %s',
    (line) => {
      const text = ['---', 'name: pack-a', 'description: x', line, '---', ''].join('\n');
      expect(() => parseSkillFrontmatter(text)).toThrowError(
        expect.objectContaining({ code: 'skill_pack_frontmatter_invalid' }),
      );
    },
  );

  it('refuses an entry file whose name disagrees with the manifest', () => {
    const other = ['---', 'name: some-other-pack', 'description: x', '---', ''].join('\n');
    expect(checkSkillPackEntry(manifest(), other)).toMatchObject({ ok: false, reason: 'name-mismatch' });
    expect(checkSkillPackEntry(manifest(), ENTRY_TEXT)).toMatchObject({ ok: true });
  });
});

describe('the in-memory reference store', () => {
  const entry = file(SKILL_PACK_ENTRY_PATH, ENTRY_TEXT);
  const guide = file('references/guide.md', 'Guide body.');
  const published = manifest({ files: [entry, guide] });
  const bodies = [
    { path: SKILL_PACK_ENTRY_PATH, content: ENTRY_TEXT },
    { path: 'references/guide.md', content: 'Guide body.' },
  ];

  it('publishes, lists, reads back, and stays tenant-scoped', async () => {
    const store = new InMemorySkillPackStore();
    const other = tenantId('tenant-other');
    await store.publish(TENANT, { manifest: published, files: bodies });

    expect(await store.list(TENANT, {})).toEqual([published]);
    expect(await store.get(TENANT, published.name)).toEqual(published);
    expect(await store.readFile(TENANT, published.name, SKILL_PACK_ENTRY_PATH)).toEqual({
      path: SKILL_PACK_ENTRY_PATH,
      contentHash: entry.contentHash,
      byteSize: entry.byteSize,
      content: ENTRY_TEXT,
    });

    // The other tenant sees a pack that never existed, not a pack it may not read.
    expect(await store.list(other, {})).toEqual([]);
    expect(await store.get(other, published.name)).toBeUndefined();
    expect(await store.readFile(other, published.name, SKILL_PACK_ENTRY_PATH)).toBeUndefined();
  });

  it('answers undefined for a file the manifest never declared', async () => {
    const store = new InMemorySkillPackStore();
    await store.publish(TENANT, { manifest: published, files: bodies });
    expect(await store.readFile(TENANT, published.name, 'references/missing.md')).toBeUndefined();
  });

  it('refuses to publish bytes that disagree with the manifest', async () => {
    const store = new InMemorySkillPackStore();
    await expect(
      store.publish(TENANT, {
        manifest: published,
        files: [bodies[0]!, { path: 'references/guide.md', content: 'Guide body, but longer.' }],
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'skill_pack_manifest_invalid' }));
  });

  it('refuses to publish a declared file that was never supplied', async () => {
    const store = new InMemorySkillPackStore();
    await expect(
      store.publish(TENANT, { manifest: published, files: [bodies[0]!] }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'skill_pack_manifest_invalid' }));
  });

  it('refuses to publish a pack with no entry file', async () => {
    const store = new InMemorySkillPackStore();
    await expect(
      store.publish(TENANT, {
        manifest: manifest({ files: [guide] }),
        files: [{ path: 'references/guide.md', content: 'Guide body.' }],
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'skill_pack_manifest_invalid' }));
  });
});
