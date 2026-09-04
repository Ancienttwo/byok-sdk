import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createByokServer } from '..';
import { isSqliteAvailable } from '../sqlite-support';
import { serverTenantId } from '../stores';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;

describeSqlite('createByokServer SQLite composition', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('selects SQLite explicitly and closes it idempotently', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-server-sqlite-'));
    directories.push(directory);
    const path = join(directory, 'server.sqlite');
    const productId = 'sqlite-composition-test';
    const seeded = createSqliteEmbeddedStores(
      { path },
      { clock: createMutableClock(), crypto: createWebCrypto() },
    );
    await seeded.cloud.tasks.open(serverTenantId(productId), {
      taskId: 'task-before-restart',
      deviceId: 'device-1',
    });
    await seeded.close();

    const server = createByokServer({
      productId,
      storage: { kind: 'sqlite', path },
    });

    await expect(server.tasks.get('task-before-restart')).resolves.toMatchObject({
      taskId: 'task-before-restart',
      state: 'Offered',
    });
    await Promise.all([server.close(), server.close()]);
    await expect(server.tasks.list()).rejects.toThrow('SQLite embedded composition is closed');
  });

  it('keeps memory as the zero-configuration default', async () => {
    const server = createByokServer({ productId: 'memory-composition-test' });
    await expect(server.tasks.list()).resolves.toEqual({ tasks: [] });
    await server.close();
  });
});
