import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderFetch } from './http';
import { ProviderRegistry, type ProviderConfiguration } from './registry';
import { InMemorySecretStore } from './secret-store';
import type { ModelProviderSecretName } from './secret-store';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';

// node:sqlite requires Node 22.5+, and shipped behind --experimental-sqlite
// until later in the 22.x line — so "Node >= 22.5" alone doesn't mean the
// module actually loads. Gate on ACTUAL availability (attempts the real
// require — see sqlite-support.ts's isSqliteAvailable), not a version-number
// heuristic, so this correctly skips on any runtime where node:sqlite isn't
// really usable (the CI Node 20 leg, or an intermediate flagged 22.x) and
// still runs on one where it is.
const sqliteReady = isSqliteAvailable();

/**
 * The in-package port of the §4.3 golden test
 * (`docs/researches/HANDOFF-byok-keys.md`; source
 * `aip-main-open@c6a5385` `apps/local-agent/src/settings.test.ts:221-334`).
 *
 * The source drives these assertions through the settings-page HTTP server,
 * which is a K3 decision and may not ship at all. The parity properties it
 * pins are not about HTTP, though — they are about the registry boundary — so
 * they are asserted here directly:
 *
 * - `:313-318` the provider really receives `Authorization: Bearer <canary>`
 *   at `https://api.openai.com/v1/chat/completions`;
 * - `:328` the SQLite file contains no plaintext key;
 * - `:333` the status projection contains no plaintext key.
 *
 * Everything runs against a real on-disk SQLite file in a temp directory, torn
 * down in `afterEach`, because "the key is not in the database file" is only
 * meaningful against actual bytes on disk.
 */
const CANARY = 'local-settings-secret-canary';

const OPENAI: ProviderConfiguration = {
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  base_url: 'https://api.openai.com/v1',
  display_name: 'OpenAI',
  model: 'gpt-5.2',
  provider_id: 'openai',
};

const successfulCompletion = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"ok":true}', role: 'assistant' } }],
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 },
  );

let directory: string;
let databasePath: string;
let profiles: SqliteProviderProfileStore;
let secrets: InMemorySecretStore<ModelProviderSecretName>;
let providerRequests: Array<{
  authorization: string | null;
  url: string;
}>;
let providerFetch: ProviderFetch;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'byok-keys-golden-'));
  databasePath = join(directory, 'provider-profile.sqlite');
  profiles = new SqliteProviderProfileStore({ path: databasePath });
  secrets = new InMemorySecretStore<ModelProviderSecretName>();
  providerRequests = [];
  providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    providerRequests.push({
      authorization: new Headers(init?.headers).get('authorization'),
      url: String(input),
    });
    return successfulCompletion();
  });
});

afterEach(async () => {
  await profiles.close();
  rmSync(directory, { force: true, recursive: true });
});

const registry = () =>
  new ProviderRegistry({
    fetchImpl: providerFetch,
    profileStore: profiles,
    secretStore: secrets,
  });

describe.skipIf(!sqliteReady)('BYOK registry golden parity (HANDOFF §4.3)', () => {
  it('saves parameters and credentials without contacting the provider', async () => {
    const status = await registry().configure(OPENAI, CANARY);
    expect(status).toMatchObject({
      model: 'gpt-5.2',
      provider_id: 'openai',
      secret_configured: true,
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('sends Authorization: Bearer <canary> to the chat/completions URL', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    const client = await subject.resolveDefaultModelProvider();
    await client?.testConnection();

    expect(providerRequests).toEqual([
      {
        authorization: `Bearer ${CANARY}`,
        url: 'https://api.openai.com/v1/chat/completions',
      },
    ]);
  });

  it('never writes the API key into the SQLite file', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    const client = await subject.resolveDefaultModelProvider();
    await client?.testConnection();
    await profiles.close();

    const database = readFileSync(databasePath);
    expect(database.includes(Buffer.from(CANARY))).toBe(false);
  });

  it('never writes the API key into the status projection', async () => {
    const subject = registry();
    await subject.configure(OPENAI, CANARY);
    const statusText = JSON.stringify({
      list: await subject.list(),
      openai: await subject.get('openai'),
    });

    expect(statusText).not.toContain(CANARY);
    expect(statusText).toContain('openai');
    expect(statusText).toContain('"secret_configured":true');
  });

  it('keeps the key only in the credential store', async () => {
    await registry().configure(OPENAI, CANARY);
    await expect(secrets.get('model-openai-api-key')).resolves.toBe(CANARY);
  });

  it('locks the database file to owner-only read/write', async () => {
    await registry().configure(OPENAI, CANARY);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it('survives a reopen of the same file, still without the key on disk', async () => {
    await registry().configure(OPENAI, CANARY);
    await profiles.close();

    profiles = new SqliteProviderProfileStore({ path: databasePath });
    const reopened = registry();
    expect((await reopened.get('openai'))?.model).toBe('gpt-5.2');
    const client = await reopened.resolveDefaultModelProvider();
    expect(client?.model).toBe('gpt-5.2');
    await profiles.close();
    expect(readFileSync(databasePath).includes(Buffer.from(CANARY))).toBe(false);
  });
});
