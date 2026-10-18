import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentHomeProjectionConsumer } from '@byok-sdk/client';
import { hash } from '../../host-execution-core/src/model';

/** Install on the daemon. SDK supplies the canonical home and writer lease. */
export function createBotPersonaProjection() {
  return createAgentHomeProjectionConsumer(async ({ cwd, projection, projectionHash }) => {
    if (!projection || typeof projection !== 'object' || !('schemaVersion' in projection)
      || projection.schemaVersion !== 'bot-profile.v1' || !('persona' in projection) || typeof projection.persona !== 'string'
      || projectionHash !== `sha256:${hash(projection)}`) throw new Error('Invalid Bot persona projection');
    const temporary = join(cwd, '.bot-persona.tmp');
    try {
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(projection.persona, 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(cwd, 'AGENTS.md'));
      const directory = await open(cwd, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  });
}
