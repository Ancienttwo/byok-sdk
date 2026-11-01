import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMutableClock } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { runActivityConformance, type ActivityCompositionFactory } from '@byok-sdk/conformance';
import { describe } from 'vitest';
import { isSqliteAvailable } from '../sqlite-support';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

/** The shared activity log suite over the embedded composition's durable store, one temp file per case. */
const factory: ActivityCompositionFactory = {
  create() {
    const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-activity-'));
    const clock = createMutableClock();
    const composition = createSqliteEmbeddedStores({ path: join(directory, 'stores.sqlite') }, { clock, crypto: createWebCrypto() });
    return {
      store: composition.cloud.activity,
      advanceTime: (ms) => clock.advance(ms),
      dispose: async () => {
        await composition.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  },
};

const describeSqlite = (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') ? describe : describe.skip;

describeSqlite('server SQLite activity store', () => {
  runActivityConformance('server SQLite', factory);
});
