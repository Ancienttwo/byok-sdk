import { describe, expect, it } from 'vitest';
import {
  BYOK_PAIR_PATH,
  BYOK_CHALLENGE_PATH,
  BYOK_TOKEN_PATH,
  BYOK_CAPABILITIES_PATH,
  BYOK_EVENTS_PATH,
  BYOK_MESSAGES_PATH,
  BYOK_PRESENCE_PATH,
  BYOK_ACTIVITY_PATH,
  BYOK_BOARD_PATH,
  BYOK_BOARD_STREAM_PATH,
  BYOK_BOARD_CLAIM_ROUTE,
  BYOK_BOARD_UNCLAIM_ROUTE,
  BYOK_BOARD_STATUS_ROUTE,
  BYOK_RECORDS_PATH,
  BYOK_RECORD_ROUTE,
  byokRecordPath,
  BYOK_SKILL_PACKS_PATH,
  BYOK_SKILL_PACK_FILE_ROUTE,
  byokSkillPackFilePath,
  BYOK_BLOBS_PATH,
  BYOK_BLOB_FINALIZE_ROUTE,
  BYOK_BLOB_URL_ROUTE,
  BYOK_BLOB_CONTENT_ROUTE,
  byokBlobFinalizePath,
  byokBlobUrlPath,
  byokBlobContentPath,
  EventsPollResponseSchema,
} from '../index';

describe('events poll capability advertisement is additive', () => {
  it('accepts both an N-1 response without capabilities and a new response with unknown future flags', () => {
    expect(EventsPollResponseSchema.parse({ events: [], cursor: 0 })).toEqual({ events: [], cursor: 0 });
    expect(
      EventsPollResponseSchema.parse({ events: [], cursor: 0, capabilities: ['result-document', 'future-flag'] }),
    ).toEqual({ events: [], cursor: 0, capabilities: ['result-document', 'future-flag'] });
  });
});

/**
 * Byte-drift net for the consolidated `/byok/*` route paths (B-2). Every
 * constant and builder here is asserted equal to the EXACT literal that used to
 * be hand-written at its call sites across client/cloud/server/testkit — so a
 * future edit to protocol's route table that silently changes a path value
 * fails here instead of shipping a wire mismatch. The right-hand strings are
 * deliberately spelled out in full (not derived) to be an independent witness.
 */
describe('byok route paths: static constants match their prior call-site literals byte-for-byte', () => {
  it.each([
    [BYOK_PAIR_PATH, '/byok/pair'],
    [BYOK_CHALLENGE_PATH, '/byok/challenge'],
    [BYOK_TOKEN_PATH, '/byok/token'],
    [BYOK_CAPABILITIES_PATH, '/byok/capabilities'],
    [BYOK_EVENTS_PATH, '/byok/events'],
    [BYOK_MESSAGES_PATH, '/byok/messages'],
    [BYOK_PRESENCE_PATH, '/byok/presence'],
    [BYOK_ACTIVITY_PATH, '/byok/activity'],
    [BYOK_BOARD_PATH, '/byok/board'],
    [BYOK_BOARD_STREAM_PATH, '/byok/board/stream'],
    [BYOK_RECORDS_PATH, '/byok/records'],
    [BYOK_SKILL_PACKS_PATH, '/byok/skill-packs'],
    [BYOK_BLOBS_PATH, '/byok/blobs'],
  ])('%s', (actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('byok route paths: router templates match their prior mount literals', () => {
  it.each([
    [BYOK_BOARD_CLAIM_ROUTE, '/byok/board/:id/claim'],
    [BYOK_BOARD_UNCLAIM_ROUTE, '/byok/board/:id/unclaim'],
    [BYOK_BOARD_STATUS_ROUTE, '/byok/board/:id/status'],
    [BYOK_RECORD_ROUTE, '/byok/records/:kind/:key'],
    [BYOK_SKILL_PACK_FILE_ROUTE, '/byok/skill-packs/:name/files/:path'],
    [BYOK_BLOB_FINALIZE_ROUTE, '/byok/blobs/:id/finalize'],
    [BYOK_BLOB_URL_ROUTE, '/byok/blobs/:id/url'],
    [BYOK_BLOB_CONTENT_ROUTE, '/byok/blobs/:id/content'],
  ])('%s', (actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('byok route paths: client builders reproduce their prior template-string literals', () => {
  it('byokRecordPath URL-encodes both segments, like truth-memory-client.ts', () => {
    const kind = 'task.terminal';
    const key = 'a b/c';
    expect(byokRecordPath(kind, key)).toBe(
      `/byok/records/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`,
    );
    expect(byokRecordPath(kind, key)).toBe('/byok/records/task.terminal/a%20b%2Fc');
  });

  it('byokSkillPackFilePath URL-encodes name and path, like skill-pack-installer.ts', () => {
    const name = 'my pack';
    const path = 'dir/file.md';
    expect(byokSkillPackFilePath(name, path)).toBe(
      `/byok/skill-packs/${encodeURIComponent(name)}/files/${encodeURIComponent(path)}`,
    );
    expect(byokSkillPackFilePath(name, path)).toBe('/byok/skill-packs/my%20pack/files/dir%2Ffile.md');
  });

  it('byokBlobFinalizePath / byokBlobUrlPath URL-encode the (client-supplied) blob id, like blob-client.ts', () => {
    const id = 'blob 1';
    expect(byokBlobFinalizePath(id)).toBe(`/byok/blobs/${encodeURIComponent(id)}/finalize`);
    expect(byokBlobUrlPath(id)).toBe(`/byok/blobs/${encodeURIComponent(id)}/url`);
    expect(byokBlobFinalizePath(id)).toBe('/byok/blobs/blob%201/finalize');
  });

  it('byokBlobContentPath does NOT encode the (server-minted) blob id, so presigned URLs stay byte-identical', () => {
    const id = 'blob-1';
    const sig = 'abc';
    const exp = 123;
    // Reproduces the exact template the reference stores used to build.
    expect(`${byokBlobContentPath(id)}?sig=${sig}&exp=${exp}`).toBe(
      `/byok/blobs/${id}/content?sig=${sig}&exp=${exp}`,
    );
    expect(byokBlobContentPath(id)).toBe('/byok/blobs/blob-1/content');
  });
});
