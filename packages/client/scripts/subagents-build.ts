import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));
const vendorRoot = path.join(clientRoot, 'vendor/pi-subagents/0.60.0');
/** Build-only resolution preserves the pre-vendoring peer anchors. */
export function subagentsBuild(sealed: boolean): Plugin {
  return { name: 'sdk-subagents-source-author', setup(builder) {
    builder.onResolve({ filter: /^@earendil-works\/(pi-agent-core|pi-tui)$/ }, args => {
      const sourceRoot = realpathSync(path.join(clientRoot, 'node_modules/pi-subagents'));
      const peerRoot = realpathSync(path.join(sourceRoot, '..', args.path));
      const manifest = JSON.parse(readFileSync(path.join(peerRoot, 'package.json'), 'utf8'));
      const entry = args.path.endsWith('/pi-agent-core') ? manifest.exports['.'].import : manifest.main;
      if (manifest.type !== 'module' || typeof entry !== 'string') throw new Error('subagents peer has no declared ESM entry');
      const resolved = path.resolve(peerRoot, entry);
      if (!resolved.startsWith(peerRoot + path.sep)) throw new Error('subagents peer entry escapes package');
      return { path: resolved };
    });
    if (sealed) builder.onResolve({ filter: /structured-output\.ts$/ }, args => {
      const resolved = path.resolve(args.resolveDir, args.path);
      if (resolved !== path.join(vendorRoot, 'src/runs/shared/structured-output.ts')) return;
      return { path: path.join(vendorRoot, 'src/runs/shared/structured-output-sealed.ts') };
    });
  } };
}
