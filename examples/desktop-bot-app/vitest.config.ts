import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'native/**', 'nsh-app/**', 'scripts/nsh.test.mjs'],
  },
});
