import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOUD_CAPABILITIES, capabilityDeclarationForPorts } from '@byok-sdk/cloud';
import { createByokServer, type CreateByokServerOptions } from '..';
import { isSqliteAvailable } from '../sqlite-support';

// #1096: the embedded server passes only the ports it serves, and its
// declaration is derived from them, so declaration and routes cannot drift.
describe('createByokServer capability declaration', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  const storages: [string, () => CreateByokServerOptions['storage']][] = [['memory', () => undefined]];
  if (isSqliteAvailable() || process.env.BYOK_REQUIRE_SQLITE === '1') {
    storages.push(['sqlite', () => {
      const directory = mkdtempSync(join(tmpdir(), 'byok-server-capabilities-'));
      directories.push(directory);
      return { kind: 'sqlite', path: join(directory, 'server.sqlite') };
    }]);
  }

  for (const [name, storage] of storages) {
    it(`serves the declaration its ports back, with no E2EE surface (${name})`, async () => {
      const selected = storage();
      const server = createByokServer({ productId: 'capability-test', ...(selected === undefined ? {} : { storage: selected }) });
      try {
        const response = await server.hono.request('/byok/capabilities');
        expect(response.status).toBe(200);
        const declared = await response.json() as { capabilities: string[] };
        expect(declared).toEqual(JSON.parse(JSON.stringify(capabilityDeclarationForPorts({ blobContentProxy: {} as never }))));
        expect(declared.capabilities).toContain(CLOUD_CAPABILITIES.blobsContentProxy);
        for (const capability of [CLOUD_CAPABILITIES.e2eeMember, CLOUD_CAPABILITIES.e2eeMemberKemEpoch, CLOUD_CAPABILITIES.truthRecords,
          CLOUD_CAPABILITIES.skillPacks, CLOUD_CAPABILITIES.agentMemoryProjection, CLOUD_CAPABILITIES.hostMcpTaskContext]) {
          expect(declared.capabilities).not.toContain(capability);
        }
        expect((await server.hono.request('/byok/e2ee/chain')).status).toBe(404);
      } finally {
        await server.close();
      }
    });
  }
});
