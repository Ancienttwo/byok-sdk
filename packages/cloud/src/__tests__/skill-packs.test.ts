/**
 * The hosted half of the skill-pack channel: the two routes, the capability
 * that decides whether they exist at all, and the tenant boundary they sit on.
 *
 * The route pair is treated the same way the `/content` pair is — declared AND
 * supplied, or absent — because the failure this prevents is a deployment that
 * publishes `skills.pack` in its declaration and then 404s the device that
 * believed it.
 */
import { createHash } from 'node:crypto';
import {
  InMemorySkillPackStore,
  SKILL_PACK_ENTRY_PATH,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  contentHash,
  parseSkillPackManifest,
  skillPackContentHashInput,
  tenantId,
  type SkillPackFile,
  type SkillPackManifest,
} from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { CLOUD_CAPABILITIES, fullCapabilityDeclaration } from '../capabilities';
import { routeKey } from '../router/registry';
import { createHarness, TENANT_A, TENANT_B } from './support/harness';

const SKILL_PACK_ROUTES = ['GET /byok/skill-packs', 'GET /byok/skill-packs/:name/files/:path'] as const;

function sha256(text: string) {
  return contentHash(`sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`);
}

const ENTRY_TEXT = [
  '---',
  'name: long-task-git-workflow',
  'description: Run a multi-day task through a Git-backed ledger.',
  '---',
  '',
  'Body.',
  '',
].join('\n');
const NESTED_TEXT = '# Ledger reference\n';
const NESTED_PATH = 'references/ledger.md';

function fileRow(path: string, content: string): SkillPackFile {
  return {
    path,
    contentHash: sha256(content),
    byteSize: Buffer.byteLength(content, 'utf8'),
  };
}

function fixturePack(): { manifest: SkillPackManifest; files: { path: string; content: string }[] } {
  const files = [fileRow(SKILL_PACK_ENTRY_PATH, ENTRY_TEXT), fileRow(NESTED_PATH, NESTED_TEXT)];
  const addressed = {
    name: 'long-task-git-workflow',
    version: '1.0.0',
    description: 'Run a multi-day task through a Git-backed ledger.',
    files,
  };
  const manifest = parseSkillPackManifest({
    schema: SKILL_PACK_MANIFEST_SCHEMA_ID,
    ...addressed,
    contentHash: sha256(skillPackContentHashInput(addressed)) as string,
  });
  return {
    manifest,
    files: [
      { path: SKILL_PACK_ENTRY_PATH, content: ENTRY_TEXT },
      { path: NESTED_PATH, content: NESTED_TEXT },
    ],
  };
}

function declaringHarness() {
  const skillPacks = new InMemorySkillPackStore();
  const harness = createHarness({
    skillPacks,
    capabilities: fullCapabilityDeclaration(1, { includeSkillPacks: true }),
  });
  return { harness, skillPacks };
}

describe('skill pack routes', () => {
  it('serves a tenant its own manifest list and file content', async () => {
    const { harness, skillPacks } = declaringHarness();
    const pack = fixturePack();
    await skillPacks.publish(TENANT_A, pack);
    const device = await harness.pairDevice(TENANT_A);

    const list = await harness.json('/byok/skill-packs', { headers: device.authorization });
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ packs: [JSON.parse(JSON.stringify(pack.manifest))] });

    const entry = await harness.json(
      `/byok/skill-packs/long-task-git-workflow/files/${encodeURIComponent(SKILL_PACK_ENTRY_PATH)}`,
      { headers: device.authorization },
    );
    expect(entry.status).toBe(200);
    expect(entry.body).toEqual({
      path: SKILL_PACK_ENTRY_PATH,
      contentHash: sha256(ENTRY_TEXT) as string,
      byteSize: Buffer.byteLength(ENTRY_TEXT, 'utf8'),
      content: ENTRY_TEXT,
    });
  });

  it('serves a nested path through a single percent-encoded segment', async () => {
    // The path is one opaque segment on the wire, so a `/` inside it can never
    // be confused with a route separator — which is also why the handler does
    // no normalization of its own.
    const { harness, skillPacks } = declaringHarness();
    await skillPacks.publish(TENANT_A, fixturePack());
    const device = await harness.pairDevice(TENANT_A);

    const nested = await harness.json(
      `/byok/skill-packs/long-task-git-workflow/files/${encodeURIComponent(NESTED_PATH)}`,
      { headers: device.authorization },
    );
    expect(nested.status).toBe(200);
    expect(nested.body).toMatchObject({ path: NESTED_PATH, content: NESTED_TEXT });
  });

  it('answers 404 for an undeclared file and for a traversal attempt alike', async () => {
    const { harness, skillPacks } = declaringHarness();
    await skillPacks.publish(TENANT_A, fixturePack());
    const device = await harness.pairDevice(TENANT_A);

    for (const path of ['references/missing.md', '../../etc/passwd', '/etc/passwd', 'SKILL.md/../SKILL.md']) {
      const response = await harness.json(
        `/byok/skill-packs/long-task-git-workflow/files/${encodeURIComponent(path)}`,
        { headers: device.authorization },
      );
      expect(response.status, path).toBe(404);
      expect(response.body, path).toEqual({ error: 'skill_pack_not_found' });
    }
  });

  it('gives another tenant nothing, and nothing that distinguishes it from absence', async () => {
    const { harness, skillPacks } = declaringHarness();
    await skillPacks.publish(TENANT_A, fixturePack());
    const mallory = await harness.pairDevice(TENANT_B);

    const list = await harness.json('/byok/skill-packs', { headers: mallory.authorization });
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ packs: [] });

    const foreign = await harness.json(
      `/byok/skill-packs/long-task-git-workflow/files/${encodeURIComponent(SKILL_PACK_ENTRY_PATH)}`,
      { headers: mallory.authorization },
    );
    const missing = await harness.json(
      `/byok/skill-packs/no-such-pack/files/${encodeURIComponent(SKILL_PACK_ENTRY_PATH)}`,
      { headers: mallory.authorization },
    );
    expect(foreign).toEqual(missing);
    expect(foreign.status).toBe(404);
  });

  it('refuses both routes to an unauthenticated caller', async () => {
    const { harness } = declaringHarness();
    for (const path of ['/byok/skill-packs', '/byok/skill-packs/long-task-git-workflow/files/SKILL.md']) {
      const response = await harness.json(path);
      expect(response.status, path).toBe(401);
      expect(response.body, path).toEqual({ error: 'unauthorized' });
    }
  });

  it('exposes no write route on the device surface', async () => {
    const { harness } = declaringHarness();
    const skillPackRoutes = harness.cloud.routes.filter((route) => route.path.startsWith('/byok/skill-packs'));
    expect(skillPackRoutes.map(routeKey).sort()).toEqual([...SKILL_PACK_ROUTES].sort());
    expect(skillPackRoutes.every((route) => route.method === 'GET')).toBe(true);
    expect(skillPackRoutes.every((route) => route.class === 'device')).toBe(true);
  });
});

describe('skills.pack capability x composition', () => {
  it('mounts nothing when the store is supplied but the capability is withheld', () => {
    const harness = createHarness({ skillPacks: new InMemorySkillPackStore() });
    const mounted = new Set(harness.cloud.mountedRoutes.map(routeKey));
    expect(SKILL_PACK_ROUTES.some((route) => mounted.has(route))).toBe(false);
  });

  it('mounts nothing when neither is present — the default deployment', () => {
    const harness = createHarness();
    const mounted = new Set(harness.cloud.mountedRoutes.map(routeKey));
    expect(SKILL_PACK_ROUTES.some((route) => mounted.has(route))).toBe(false);
    expect(harness.cloud.capabilities.capabilities).not.toContain(CLOUD_CAPABILITIES.skillPacks);
  });

  it('refuses to construct a deployment that declares the channel it has no store for', () => {
    expect(() =>
      createHarness({ capabilities: fullCapabilityDeclaration(1, { includeSkillPacks: true }) }),
    ).toThrowError(expect.objectContaining({ code: 'capability_over_declared' }));
  });

  it('mounts the pair, and only the pair, once both halves are present', () => {
    const { harness } = declaringHarness();
    const mounted = new Set(harness.cloud.mountedRoutes.map(routeKey));
    for (const route of SKILL_PACK_ROUTES) expect(mounted.has(route)).toBe(true);
    expect(harness.cloud.capabilities.capabilities).toContain(CLOUD_CAPABILITIES.skillPacks);
    // Inventory and router still agree with the pair added.
    expect(harness.cloud.routes.map(routeKey).sort()).toEqual([...mounted].sort());
  });

  it('keeps skills.pack out of the default declaration', () => {
    // A default-on capability would make every existing in-memory deployment
    // refuse to construct, so the default has to stay off — the same posture
    // `truth.records` takes.
    expect(fullCapabilityDeclaration().capabilities).not.toContain(CLOUD_CAPABILITIES.skillPacks);
    expect(fullCapabilityDeclaration(1, { includeSkillPacks: true }).capabilities).toContain(
      CLOUD_CAPABILITIES.skillPacks,
    );
  });
});

describe('tenant scoping of the store itself', () => {
  it('keeps one tenant’s publication invisible to another at the port', async () => {
    const store = new InMemorySkillPackStore();
    const other = tenantId('tenant-c');
    await store.publish(TENANT_A, fixturePack());
    expect(await store.list(TENANT_A, {})).toHaveLength(1);
    expect(await store.list(other, {})).toHaveLength(0);
  });
});
