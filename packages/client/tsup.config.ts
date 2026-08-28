import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof manifest.version !== 'string') throw new Error('packages/client/package.json must declare a string version');

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/adapters/index.ts',
    'src/agent-memory/index.ts',
    'src/adapters/pi/mcp-extension.ts',
    'src/bin/byok-agent.ts',
    'src/bin/byok-approval-mcp.ts',
    'src/bin/byok-agent-message-mcp.ts',
    'src/bin/byok-agent-memory-mcp.ts',
  ],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  define: {
    __BYOK_CLIENT_PACKAGE_VERSION__: JSON.stringify(manifest.version),
  },
});
