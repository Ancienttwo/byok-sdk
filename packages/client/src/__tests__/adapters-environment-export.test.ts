import { expect, it } from 'vitest';
import * as adapters from '../adapters';

it('offers direct adapter hosts the same environment builder and error the adapters use (#1095)', async () => {
  expect(adapters).toHaveProperty('RuntimeEnvironmentUnavailableError');
  expect(await adapters.buildRuntimeEnvironment({ base: 'allowlist' })).toHaveProperty('NO_PROXY');
});
