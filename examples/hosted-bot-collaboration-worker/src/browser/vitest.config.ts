import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const { version } = require('playwright/package.json') as { version: string };

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    include: ['src/browser/vectors.browser.ts'],
    reporters: ['verbose'],
    silent: false,
    provide: { playwrightVersion: version },
    testTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
