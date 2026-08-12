/**
 * `GET /byok/skill-packs` and `GET /byok/skill-packs/:name/files/:path` — the
 * hosted half of the skill-pack delivery channel.
 *
 * Two device-class reads, and nothing else. There is no publish route here on
 * purpose: a device is a CONSUMER of packs, and a device-bearer-authed write
 * would let any paired device in a tenant publish content to every other device
 * in it. Publication is a host control-plane action against the store directly,
 * exactly as board item creation is.
 *
 * Both routes answer 404 for a pack this tenant does not have — the same answer
 * a name that never existed anywhere gets — so the surface is not a
 * cross-tenant existence oracle. The store is tenant-first, so that property
 * comes from the lookup key rather than from a comparison a handler could
 * forget.
 *
 * Bytes travel as UTF-8 text inside JSON. A pack carries Markdown, YAML and
 * static text; there is no archive to unpack and no binary channel to
 * negotiate, which is the same reason the manifest has no exec surface — the
 * format cannot express the thing we do not want it to express.
 */
import { principalTenant, type SkillPackStore } from '@byok-sdk/core';
import type { Context } from 'hono';
import { authenticateBearer, type BearerAuthDeps } from '../auth/bearer';

/** Rows per `GET /byok/skill-packs` response. A tenant's pack catalogue is small by design. */
export const DEFAULT_SKILL_PACK_PAGE_LIMIT = 50;

export interface SkillPackRouteDeps {
  readonly bearer: BearerAuthDeps;
  readonly skillPacks: SkillPackStore;
  readonly pageLimit: number;
}

export function skillPackListHandler(deps: SkillPackRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const device = await authenticateBearer(c.req.header('authorization'), deps.bearer);
    if (device === undefined) return unauthorized(c);

    const packs = await deps.skillPacks.list(principalTenant(device), { limit: deps.pageLimit });
    return c.json({ packs }, 200);
  };
}

export function skillPackFileHandler(deps: SkillPackRouteDeps) {
  return async (c: Context): Promise<Response> => {
    const device = await authenticateBearer(c.req.header('authorization'), deps.bearer);
    if (device === undefined) return unauthorized(c);

    const name = c.req.param('name');
    const path = c.req.param('path');
    if (name === undefined || path === undefined) return notFound(c);

    // No path normalization, no resolution, no decoding step of our own: the
    // store answers only for a path its own manifest declares, and those paths
    // passed core's path rule at publish time. A handler that "cleaned up" a
    // requested path would be inventing a second, weaker authority over what a
    // pack contains.
    const file = await deps.skillPacks.readFile(principalTenant(device), name, path);
    if (file === undefined) return notFound(c);
    return c.json(file, 200);
  };
}

function unauthorized(c: Context): Response {
  return c.json({ error: 'unauthorized' }, 401);
}

function notFound(c: Context): Response {
  return c.json({ error: 'skill_pack_not_found' }, 404);
}
