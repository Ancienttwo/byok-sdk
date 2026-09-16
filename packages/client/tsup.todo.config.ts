import { defineConfig } from 'tsup';
import { fileURLToPath } from 'node:url';

// Only the private todo graph gets pure UI subtree inlining. The main host's
// unrelated extension graphs retain their own existing external boundaries.
export default defineConfig({
  entry: ['src/bin/pi-todo-runtime.js'],
  format: ['esm'], target: 'es2022', platform: 'node',
  dts: false, sourcemap: true, metafile: true, clean: false, splitting: false, treeshake: true,
  outDir: 'dist/bin',
  // The upstream JS stays byte-identical. Its one bare width edge has exactly
  // this private author, independently asserted from the build metafile.
  // Uniform production output, not a scanner exception: non-minified esbuild
  // retains inlined source paths in comments and __esm debug labels. Main dist
  // is untouched; sourcemaps and THIRD-PARTY retain source/license provenance.
  esbuildOptions(options) {
    options.alias = { 'get-east-asian-width': fileURLToPath(new URL('./vendor/get-east-asian-width/1.6.0/index.js', import.meta.url)) };
    options.minifySyntax = true;
    options.minifyWhitespace = true;
    options.legalComments = 'inline';
  },
  noExternal: ['@juicesharp/rpiv-i18n', '@juicesharp/rpiv-config',
    'typebox', '@earendil-works/pi-ai'],
});
