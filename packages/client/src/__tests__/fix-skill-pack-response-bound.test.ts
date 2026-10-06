import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contentHash,
  skillPackContentHashInput,
  SKILL_PACK_MANIFEST_SCHEMA_ID,
  type CapabilityDeclaration,
} from '@byok-sdk/core';
import type { AuthManager } from '../daemon/auth-manager';
import { authedFetch } from '../daemon/http-client';
import { installSkillPacks, SKILL_PACK_RESPONSE_MAX_BYTES } from '../daemon/skill-pack-installer';

vi.mock('../daemon/http-client', () => ({ authedFetch: vi.fn() }));
const declaration: CapabilityDeclaration = { schema: 'byok-capabilities-v1', version: 1, capabilities: ['skills.pack'] };
let temporary: string;
let dataDir: string;
const install = () => installSkillPacks({ dataDir, serverUrl: 'https://fixture.invalid', auth: {} as AuthManager, declaration });
const tooLarge = expect.objectContaining({ name: 'SkillPackInstallError', code: 'response_too_large' });

function oversizedResponse(declaredLength?: number, cancelMode: 'normal' | 'reject' | 'pending' = 'normal') {
  const chunk = new Uint8Array(64 * 1024);
  let pulls = 0;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(chunk);
      if (pulls === 128) controller.close();
    },
    cancel() {
      cancellations++;
      if (cancelMode === 'reject') return Promise.reject(new Error('fixture cancel failed'));
      if (cancelMode === 'pending') return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
  const response = new Response(stream, {
    headers: declaredLength === undefined ? {} : { 'content-length': String(declaredLength) },
  });
  return { response, counts: () => ({ pulls, cancellations, delivered: pulls * chunk.byteLength }) };
}

function chunkedResponse(bytes: Uint8Array, chunkSize: number): Response {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) { controller.close(); return; }
      const next = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, next));
      offset = next;
    },
  }, { highWaterMark: 0 }));
}

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-response-'));
  dataDir = path.join(temporary, 'data');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('14-3 bounded skill-pack responses', () => {
  it.each([undefined, 1])('stops oversized decoded bytes with declared length %s', async (declaredLength) => {
    const fixture = oversizedResponse(declaredLength);
    vi.mocked(authedFetch).mockResolvedValue(fixture.response);
    await expect(install()).rejects.toThrowError(tooLarge);
    expect(fixture.counts()).toEqual({ pulls: 33, cancellations: 1, delivered: SKILL_PACK_RESPONSE_MAX_BYTES + 64 * 1024 });
    expect(fixture.response.body!.locked).toBe(false);
    await expect(fs.lstat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a declared oversize response without pulling its body', async () => {
    const fixture = oversizedResponse(SKILL_PACK_RESPONSE_MAX_BYTES + 1);
    vi.mocked(authedFetch).mockResolvedValue(fixture.response);
    await expect(install()).rejects.toThrowError(tooLarge);
    expect(fixture.counts()).toEqual({ pulls: 0, cancellations: 1, delivered: 0 });
    expect(fixture.response.body!.locked).toBe(false);
    await expect(fs.lstat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { cancelMode: 'reject', declaredLength: undefined },
    { cancelMode: 'pending', declaredLength: undefined },
    { cancelMode: 'reject', declaredLength: SKILL_PACK_RESPONSE_MAX_BYTES + 1 },
    { cancelMode: 'pending', declaredLength: SKILL_PACK_RESPONSE_MAX_BYTES + 1 },
  ] as const)('keeps oversize refusal bounded with $cancelMode cancellation and length $declaredLength', async ({ cancelMode, declaredLength }) => {
    const fixture = oversizedResponse(declaredLength, cancelMode);
    vi.mocked(authedFetch).mockResolvedValue(fixture.response);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('refusal waited for cancellation')), 1000); });
      await expect(Promise.race([install(), timeout])).rejects.toThrowError(tooLarge);
      expect(fixture.counts().cancellations).toBe(1);
      expect(fixture.response.body!.locked).toBe(false);
    } finally { clearTimeout(timer); }
  });

  it.each([SKILL_PACK_RESPONSE_MAX_BYTES - 1, SKILL_PACK_RESPONSE_MAX_BYTES])('accepts valid JSON with %i delivered bytes', async (length) => {
    const bytes = new TextEncoder().encode('{"packs":[]}'.padEnd(length, ' '));
    const response = chunkedResponse(bytes, 8192);
    vi.mocked(authedFetch).mockResolvedValue(response);
    expect(await install()).toEqual({ installed: [], unchanged: [] });
    expect(response.body!.locked).toBe(false);
  });

  it('refuses exactly one byte over the cap', async () => {
    const response = chunkedResponse(new TextEncoder().encode('{"packs":[]}'.padEnd(SKILL_PACK_RESPONSE_MAX_BYTES + 1, ' ')), SKILL_PACK_RESPONSE_MAX_BYTES);
    vi.mocked(authedFetch).mockResolvedValue(response);
    await expect(install()).rejects.toThrowError(tooLarge);
    expect(response.body!.locked).toBe(false);
  });

  it('releases the reader if the source fails', async () => {
    const failure = new Error('fixture read failure');
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(failure); },
    }, { highWaterMark: 0 }));
    vi.mocked(authedFetch).mockResolvedValue(response);
    await expect(install()).rejects.toBe(failure);
    expect(response.body!.locked).toBe(false);
  });

  it('decodes a UTF-8 character split across chunks', async () => {
    const response = chunkedResponse(new TextEncoder().encode('{"packs":[],"note":"€"}'), 1);
    vi.mocked(authedFetch).mockResolvedValue(response);
    expect(await install()).toEqual({ installed: [], unchanged: [] });
  });

  it.each([new Uint8Array(), new TextEncoder().encode('not json'), new Uint8Array([0xff])])('preserves invalid JSON and UTF-8 refusal', async (bytes) => {
    const response = chunkedResponse(bytes, 1);
    vi.mocked(authedFetch).mockResolvedValue(response);
    await expect(install()).rejects.toThrowError(expect.objectContaining({ code: 'response_invalid' }));
    expect(response.body!.locked).toBe(false);
  });

  it('refuses an absent body as invalid JSON', async () => {
    vi.mocked(authedFetch).mockResolvedValue(new Response(null));
    await expect(install()).rejects.toThrowError(expect.objectContaining({ code: 'response_invalid' }));
  });

  it('bounds individual file responses before any pack is installed', async () => {
    const content = '---\nname: fixture\ndescription: Fixture.\n---\nBody.\n';
    const sha256 = (text: string) => contentHash(`sha256:${createHash('sha256').update(text).digest('hex')}`);
    const addressed = {
      name: 'fixture', version: '1.0.0', description: 'Fixture.',
      files: [{ path: 'SKILL.md', byteSize: Buffer.byteLength(content), contentHash: sha256(content) }],
    };
    const manifest = { schema: SKILL_PACK_MANIFEST_SCHEMA_ID, ...addressed, contentHash: sha256(skillPackContentHashInput(addressed)) };
    const fixture = oversizedResponse();
    vi.mocked(authedFetch).mockResolvedValueOnce(Response.json({ packs: [manifest] })).mockResolvedValueOnce(fixture.response);
    await expect(install()).rejects.toThrowError(tooLarge);
    expect(fixture.counts().pulls).toBe(33);
    expect(fixture.counts().cancellations).toBe(1);
    await expect(fs.lstat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
