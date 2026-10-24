// Public-API packaging probe. All state and credentials are fixture-owned.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createByokServer, createHmacTokenSigner } from '@byok-sdk/server';
import { createDaemonWithAdapters, SqliteLocalTaskJournal, journalHash } from '@byok-sdk/client';
import { SqliteProviderProfileStore, parseModelProviderProfile } from '@byok-sdk/keys';
import { InMemoryDeviceCredentialStore } from '../../scripts/testing/device-credentials.mjs';

async function main() {
  const root = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'b-sql-')));
  try {
    new DatabaseSync(':memory:').close(); // Control: the runtime really has SQLite.
    const options = { productId: 'sqlite-bundle', storage: { kind: 'sqlite' as const, path: join(root, 'server.sqlite') },
      tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(1), { now: () => new Date() }), wake: { consume: async () => {} } };
    let server = createByokServer(options);
    try { await server.wakes.schedule({ dedupKey: 'roundtrip', availableAt: Date.now() + 60_000 }); }
    finally { await server.close(); }
    server = createByokServer(options);
    try { assert.equal((await server.wakes.pending())[0]?.dedupKey, 'roundtrip'); }
    finally { await server.close(); }

    const storeDir = join(root, 'daemon');
    const daemon = createDaemonWithAdapters({ productId: 'sqlite-bundle', productName: 'SQLite bundle probe',
      localAgentRelease: { version: '0.0.0-test' }, serverUrl: 'http://127.0.0.1:0', storeDir, workspaceRoot: root,
      storage: { scratchRoot: join(root, 'scratch') },
    }, [], { deviceCredentials: new InMemoryDeviceCredentialStore() });
    try {
      // Startup opens its owned journal before reporting the empty enrollment.
      // It never pairs or connects, and never selects OS credential custody.
      await assert.rejects(daemon.start(), { reason: 'unpaired' });
    } finally { await daemon.stop(); }
    const schema = new DatabaseSync(join(storeDir, 'daemon.db'), { readOnly: true });
    try { assert.ok(schema.prepare("SELECT name FROM sqlite_schema WHERE name='journal_task'").get()); }
    finally { schema.close(); }
    let journal = new SqliteLocalTaskJournal({ storeDir });
    const bytes = JSON.stringify({ v: 1, id: 'env-probe', type: 'task.offer', task_id: 'probe', seq: 1 });
    try {
      const receipt = await journal.appendEnvelope({ identity: { tenantId: 'tenant', productId: 'sqlite-bundle', deviceId: 'device' },
        envelopeId: 'env-probe', taskId: 'probe', seq: 1, bytes, bytesHash: journalHash(bytes),
        receivedAt: '2026-10-21T00:00:00Z', opensTask: true });
      assert.equal(receipt.created, true);
    } finally { await journal.close(); }
    journal = new SqliteLocalTaskJournal({ storeDir });
    try { assert.equal((await journal.listRecoverable())[0]?.taskId, 'probe'); }
    finally { await journal.close(); }

    const profile = parseModelProviderProfile({ adapter: 'openai_compatible', auth_mode: 'none',
      base_url: 'http://127.0.0.1:9191/v1', capabilities: [], created_at: '2026-10-21T00:00:00Z',
      updated_at: '2026-10-21T00:00:00Z', display_name: 'SQLite probe', enabled: true, kind: 'model',
      model: 'probe', profile_ref: 'probe', provider_kind: 'custom' });
    const path = join(root, 'profiles.sqlite');
    let profiles = new SqliteProviderProfileStore({ path });
    try { await profiles.save(profile); } finally { await profiles.close(); }
    profiles = new SqliteProviderProfileStore({ path });
    try { assert.deepEqual(await profiles.get(profile.profile_ref), { ...profile, pi_model: undefined }); }
    finally { await profiles.close(); }
    console.log('BYOK_SQLITE_BUNDLE_OK server daemon-journal keys');
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
