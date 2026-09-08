import config from '../../packages/client/vitest.config';
export default { ...config, test: { ...config.test, setupFiles: [new URL('./sync-delay.setup.ts', import.meta.url).pathname], testTimeout: 60000 } };
