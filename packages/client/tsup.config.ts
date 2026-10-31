import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';
import { workspaceExternals } from './scripts/workspace-externals';

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown };
if (typeof manifest.version !== 'string') throw new Error('packages/client/package.json must declare a string version');

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/adapters/hermes/hermes-session-runtime.ts',
    'src/adapters/index.ts',
    'src/agent-memory/index.ts',
    'src/assertion-client/index.ts',
    'src/mcp-server/index.ts',
    'src/mcp-server/http.ts',
    'src/testing/index.ts',
    'src/adapters/packaging.ts',
    'src/adapters/pi/mcp-extension.ts',
    'src/adapters/pi/team-interaction-extension.ts',
    'src/bin/byok-agent.ts',
    'src/bin/byok-pi-prepared.ts',
    'src/bin/byok-pi-durable.ts',
    'src/bin/byok-pi-rpc.ts',
    'src/bin/pi-runtime-host.ts',
    'src/bin/pi-subagent-gate.ts',
    'src/runtime/acp-session-runtime.js',
    'src/bin/byok-agent-message-mcp.ts',
    'src/bin/byok-agent-result-mcp.ts',
    'src/bin/byok-agent-memory-mcp.ts',
    'src/bin/byok-agent-memory-describe.ts',
    'src/bin/byok-agent-team-mcp.ts',
  ],
  format: ['esm'],
  target: 'es2022',
  platform: 'node',
  // Keep `node:` on builtins: a bundler that packs this output (a byok-agent payload, #1097) resolves
  // `node:readline/promises`, while esbuild does not list the bare `readline/promises` as a builtin.
  removeNodeProtocol: false,
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // Strip source comments and formatting without renaming symbols or rewriting syntax.
  minifyWhitespace: true,
  esbuildOptions(options) {
    options.legalComments = 'inline';
  },
  // Let our plugin annotate these external edges before tsup short-circuits them.
  noExternal: [/^@byok-sdk\//],
  esbuildPlugins: [workspaceExternals(), {
    name: 'mcp-http-core-entry',
    setup(build) {
      // Both public entries must use the same error class and method core.
      // Inlining this import would create a private McpServerToolError copy.
      build.onResolve({ filter: /^\.\/index$/ }, args => {
        if (args.importer.replace(/\\/g, '/').endsWith('/src/mcp-server/http.ts')) {
          return { path: './index.js', external: true };
        }
        return undefined;
      });
    },
  }],
  // koffi is the win32 job-object backstop's native binding layer and an
  // `optionalDependencies` entry: it must stay a runtime resolution so a
  // non-win32 install (where the addon may be absent) never has it inlined,
  // and so the win32 branch loads the host's own prebuilt addon.
  external: [
    'koffi', '#byok-hermes-session', '#byok-acp-runtime', '#byok-pi-runtime-host', '#byok-pi-runtime-host-sealed', '#byok-pi-todo-runtime',
    'typebox', 'typebox/compile',
    'undici',
  ],
  define: {
    __BYOK_CLIENT_PACKAGE_VERSION__: JSON.stringify(manifest.version),
    // Only the installed host loads the pi-subagents dependency; the sealed host never references it.
    __BYOK_PI_SUBAGENTS__: 'true',
  },
});
