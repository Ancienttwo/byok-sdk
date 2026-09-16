/**
 * Built-bundle closure guard for every entry a host may import WITHOUT taking
 * the daemon graph.
 *
 * The problem this exists for is not size. `dist/index.js` statically imports
 * `@modelcontextprotocol/client`, whose published dist embeds an `ajv` provider
 * built on `new Function`, and it reaches `@earendil-works/pi-coding-agent`
 * (and through it `@modelcontextprotocol/sdk` -> `ajv`) as well. A host that
 * runs its toolset servers under a Content-Security-Policy, a locked-down
 * runtime, or any policy that refuses runtime code generation therefore could
 * not call `requestTaskAssertion` at all — because of code it never invokes.
 * `@byok-sdk/client/assertion-client` is the answer, and this file is the only
 * thing that keeps the answer true after the next unrelated import lands.
 *
 * What is checked, per guarded file:
 *
 * 1. No runtime code generation: `new Function`, a bare `Function(` call,
 *    `eval(`, `process.dlopen`, `Bun.plugin`.
 * 2. No opaque module resolution: `import(` or `require(` whose argument is not
 *    a string literal.
 * 3. No trace of the refused graph: `ajv`, `pi-coding-agent`, `@earendil-works`,
 *    `jiti`, `photon`, `@modelcontextprotocol/client`.
 * 4. Every static import specifier is a node builtin, `@byok-sdk/core`,
 *    `@byok-sdk/protocol`, or a relative path.
 *
 * Rules 1-4 are applied to the guarded entry AND to every file it reaches by a
 * relative import that resolves inside `dist/`, each visited once, so a shared
 * chunk cannot launder a forbidden edge past the "or a relative path" clause.
 * Today that closure is one file per entry, because `tsup.config.ts` sets
 * `splitting: false` — which `the build configuration the scan depends on`
 * asserts by name, so a future chunk split is caught by either half.
 *
 * KNOWN LIMITATION, stated rather than hidden: this is a regex scan over the
 * emitted text, not a parse. It cannot see a call assembled at runtime
 * (`globalThis['ev' + 'al']`), an indirect alias (`const f = Function; f(...)`),
 * or a specifier built from concatenation. It is a tripwire against the
 * realistic failure — an ordinary import landing in a guarded entry's graph and
 * silently dragging a code-generating dependency in — not a sandbox. The string
 * checks are correspondingly substring checks, deliberately blunt.
 *
 * The other half of that limitation is the workspace boundary: `@byok-sdk/core`
 * and `@byok-sdk/protocol`, plus `@byok-sdk/implementation-identity`, are ALLOWLISTED as specifiers, not scanned. Their
 * own dists are never read here, so a code-generating dependency landing inside
 * either of them is invisible to this suite. They are in-repo packages with
 * their own build and their own tests; the guard is scoped to this package's
 * emitted graph.
 *
 * NON-VACUITY: the same checker is run against `dist/index.js` at the bottom of
 * this file and MUST report hits. A checker that passes everything is worse
 * than no checker, so the root entry is the control that proves it can fail.
 *
 * WHAT THE ROOT ENTRY IS AND IS NOT, stated because the two are easy to
 * conflate. `dist/index.js` EXTERNALISES `@modelcontextprotocol/client`: the
 * specifier is emitted, the package's own bytes are not, so nothing in this
 * file can see which provider that package will resolve to. The package picks
 * its JSON Schema provider through the `./_shims` conditional export, and the
 * `node`/`default` branch is the ajv-backed one built on `new Function`.
 * Whether a consumer's FINAL bundle is codegen-free therefore depends on how
 * the consumer's bundler resolves `_shims` — a fact about their build, not
 * about this dist, and not something this scan asserts either way.
 *
 * `src/mcp/client.ts` names `CfWorkerJsonSchemaValidator` explicitly for the
 * SDK's own MCP client, which settles the RUNTIME choice — the provider that
 * actually validates a tool result's `structuredContent` is the eval-free one
 * on every host. It does not remove ajv from a bundle that resolved `_shims`
 * to the node branch, and no assertion here pretends otherwise; the injection
 * is covered by `mcp-output-schema-validator.test.ts`. The root entry stays
 * exactly what it has always been in this file: the negative control.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIST = path.join(PACKAGE_ROOT, 'dist');

/**
 * The entries a host may import without the daemon composition.
 *
 * `dist/adapters/index.js` carries one documented exception. It bundles the Pi
 * adapter, which must NAME the Pi package to read the client manifest's exact
 * alias pin (`PI_PACKAGE_NAME`, `src/adapters/pi/mcp-config.ts`). That is a data
 * constant, not a dependency edge — the file imports nothing from it, which
 * rule 4 independently proves. The exception is therefore scoped to those two
 * substrings on that one file, and `pins the pi package name as data, never as
 * a module edge` below asserts the exception itself so it cannot quietly widen
 * into a real import.
 */
const GUARDED: readonly { readonly file: string; readonly allowedSubstrings: readonly string[] }[] = [
  { file: 'assertion-client/index.js', allowedSubstrings: [] },
  { file: 'mcp-server/index.js', allowedSubstrings: [] },
  { file: 'adapters/index.js', allowedSubstrings: ['pi-coding-agent', '@earendil-works'] },
  { file: 'agent-memory/index.js', allowedSubstrings: [] },
  { file: 'bin/byok-approval-mcp.js', allowedSubstrings: [] },
  { file: 'bin/byok-agent-message-mcp.js', allowedSubstrings: [] },
  { file: 'bin/byok-agent-memory-mcp.js', allowedSubstrings: [] },
  { file: 'bin/byok-agent-team-mcp.js', allowedSubstrings: [] },
];

/** The only bare specifiers a guarded entry may statically import. */
const ALLOWED_BARE_IMPORTS = new Set(['@byok-sdk/core', '@byok-sdk/protocol', '@byok-sdk/implementation-identity']);

const FORBIDDEN_SUBSTRINGS = [
  'ajv',
  'pi-coding-agent',
  '@earendil-works',
  'jiti',
  'photon',
  '@modelcontextprotocol/client',
] as const;

const CODEGEN_RULES: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: 'new Function', pattern: /\bnew\s+Function\s*\(/g },
  // A bare `Function(...)` call is the same constructor without `new`. The
  // lookbehind keeps `AsyncFunction`, `obj.Function`, `$Function` out.
  { rule: 'Function( constructor call', pattern: /(?<![.\w$])Function\s*\(/g },
  { rule: 'eval(', pattern: /(?<![.\w$])eval\s*\(/g },
  { rule: 'process.dlopen', pattern: /\bprocess\s*\.\s*dlopen\b/g },
  { rule: 'Bun.plugin', pattern: /\bBun\s*\.\s*plugin\b/g },
  // Argument is not a string literal => the specifier is opaque to this scan
  // and to any downstream bundler. Regex-level: see KNOWN LIMITATION above.
  { rule: 'dynamic import( with a non-literal specifier', pattern: /(?<![.\w$])import\s*\(\s*(?!['"`])/g },
  { rule: 'require( with a non-literal specifier', pattern: /(?<![.\w$])require\s*\(\s*(?!['"`])/g },
];

interface Hit {
  readonly rule: string;
  readonly line: number;
  readonly excerpt: string;
}

function lineNumberOf(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') line += 1;
  }
  return line;
}

function excerptAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end).trim().slice(0, 160);
}

/** Every hit in one emitted bundle, under the rules documented at the top. */
function scanBundle(source: string, allowedSubstrings: readonly string[] = []): Hit[] {
  const hits: Hit[] = [];
  for (const { rule, pattern } of CODEGEN_RULES) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      hits.push({ rule, line: lineNumberOf(source, match.index), excerpt: excerptAt(source, match.index) });
    }
  }
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    if (allowedSubstrings.includes(needle)) continue;
    let from = 0;
    for (;;) {
      const index = source.indexOf(needle, from);
      if (index === -1) break;
      hits.push({
        rule: `forbidden substring ${JSON.stringify(needle)}`,
        line: lineNumberOf(source, index),
        excerpt: excerptAt(source, index),
      });
      from = index + needle.length;
    }
  }
  return hits;
}

const FROM_SPECIFIER = /(?:^|[^\w$.])(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/g;

/** The static module edges an emitted ESM bundle actually declares. */
function staticImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [FROM_SPECIFIER, SIDE_EFFECT_IMPORT]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1] !== undefined) specifiers.add(match[1]);
    }
  }
  return [...specifiers].sort();
}

function disallowedSpecifiers(source: string): string[] {
  return staticImportSpecifiers(source).filter(
    (specifier) =>
      !specifier.startsWith('.') && !isBuiltin(specifier) && !ALLOWED_BARE_IMPORTS.has(specifier),
  );
}

function describeHits(hits: readonly Hit[]): string {
  return hits.map((hit) => `  ${hit.rule} @ line ${hit.line}: ${hit.excerpt}`).join('\n');
}

/**
 * Resolve a relative specifier declared inside `fromRelPath` to a path under
 * `dist/`, or `undefined` if it escapes `dist/` or does not exist on disk.
 *
 * `splitting: false` (asserted below) means a guarded entry is a single
 * self-contained file today, so this normally finds nothing. It exists so that
 * the day a chunk split lands, the chunk is scanned instead of silently
 * admitted by the "or a relative path" clause of rule 4.
 */
function resolveInsideDist(fromRelPath: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(path.join(DIST, fromRelPath)), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
    const relative = path.relative(DIST, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (existsSync(candidate) && !candidate.endsWith(path.sep)) {
      try {
        readFileSync(candidate, 'utf8');
      } catch {
        continue;
      }
      return relative;
    }
  }
  return undefined;
}

/**
 * Every file reachable from a guarded entry by relative static imports that
 * stay inside `dist/`, entry first, each visited exactly once.
 */
function distClosure(entryRelPath: string): { readonly file: string; readonly source: string }[] {
  const visited = new Set<string>();
  const queue = [entryRelPath];
  const files: { file: string; source: string }[] = [];
  while (queue.length > 0) {
    const relative = queue.shift() as string;
    const key = relative.split(path.sep).join('/');
    if (visited.has(key)) continue;
    visited.add(key);
    const source = readFileSync(path.join(DIST, relative), 'utf8');
    files.push({ file: key, source });
    for (const specifier of staticImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const next = resolveInsideDist(relative, specifier);
      if (next !== undefined) queue.push(next);
    }
  }
  return files;
}

const DIST_PRESENT = existsSync(path.join(DIST, 'index.js'));
if (!DIST_PRESENT) {
  // Loud on purpose. A closure guard that silently passes on a missing build is
  // worse than no guard: it reports green for a bundle nobody produced.
  console.error(
    '\n!!! dist-subpath-closure: SKIPPED — packages/client/dist is absent.\n' +
      '!!! This suite checks EMITTED bundles, so it proves nothing until `bun run build` has run.\n' +
      '!!! Nothing below was verified. Run `bun run build`, then re-run this suite.\n',
  );
}

// Not gated on the build: this reads the build CONFIG, and it is the first
// half of the chunk-split defence. `splitting: false` is what makes each
// guarded entry a single self-contained file, so the scan below sees the whole
// graph. The second half is `distClosure`, which follows a relative import
// into dist/ if one ever appears anyway. Either alone would be enough; both
// are here so a future `splitting: true` is caught by a named assertion rather
// than by inference from a passing scan.
describe('the build configuration the scan depends on', () => {
  it('keeps tsup `splitting: false`, so each guarded entry is one self-contained file', () => {
    const config = readFileSync(path.join(PACKAGE_ROOT, 'tsup.config.ts'), 'utf8');
    expect(config).toMatch(/\bsplitting\s*:\s*false\b/);
    expect(config).not.toMatch(/\bsplitting\s*:\s*true\b/);
  });
});

describe.skipIf(!DIST_PRESENT)('the daemon-free dist sub-path closures', () => {
  for (const { file, allowedSubstrings } of GUARDED) {
    describe(`dist/${file}`, () => {
      // The entry plus every dist-internal file it reaches by a relative
      // import. Both assertions below apply the same rules to the whole
      // closure, so a shared chunk cannot launder a forbidden edge.
      const closure = DIST_PRESENT ? distClosure(file) : [];

      it('generates no code at runtime and carries no trace of the refused graph', () => {
        const report = closure
          .map(({ file: member, source }) => ({ member, hits: scanBundle(source, allowedSubstrings) }))
          .filter(({ hits }) => hits.length > 0)
          .map(({ member, hits }) => `dist/${member}:\n${describeHits(hits)}`)
          .join('\n');
        expect(report).toBe('');
      });

      it('statically imports only node builtins, @byok-sdk/core, @byok-sdk/protocol, or relative paths', () => {
        const report = closure
          .map(({ file: member, source }) => ({ member, bad: disallowedSpecifiers(source) }))
          .filter(({ bad }) => bad.length > 0)
          .map(({ member, bad }) => `dist/${member}: ${bad.join(', ')}`);
        expect(report).toEqual([]);
      });
    });
  }

  it('pins the pi package name in dist/adapters/index.js as data, never as a module edge', () => {
    const source = readFileSync(path.join(DIST, 'adapters', 'index.js'), 'utf8');
    // The exception granted above is only defensible while every occurrence is
    // an assignment of the name to a constant. An import, a re-export, or a
    // dynamic `import()` of it fails here even though the substring is allowed.
    const occurrences = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(({ text }) => text.includes('pi-coding-agent') || text.includes('@earendil-works'));
    expect(occurrences.map(({ text }) => text)).toEqual(['var PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";']);
    expect(
      staticImportSpecifiers(source).filter((specifier) => specifier.includes('pi-coding-agent')),
    ).toEqual([]);
  });

  // The control. If this ever passes, every assertion above is worthless.
  it('reports hits on dist/index.js, proving the checker is not vacuous', () => {
    const rootSource = readFileSync(path.join(DIST, 'index.js'), 'utf8');
    const hits = scanBundle(rootSource);
    // Per family, not an OR: an OR passes while one family's detector rots.
    // The non-literal-`import(`/`require(` family is deliberately absent —
    // dist/index.js has no computed import today, so asserting it here would
    // assert a fact about the root bundle rather than about the checker. The
    // two substring families below are the ones that exist.
    const mcpClientHits = hits.filter((hit) => hit.rule.includes('@modelcontextprotocol/client'));
    const piHits = hits.filter((hit) => hit.rule.includes('pi-coding-agent'));
    expect({
      '@modelcontextprotocol/client': mcpClientHits.length > 0,
      'pi-coding-agent': piHits.length > 0,
    }).toEqual({ '@modelcontextprotocol/client': true, 'pi-coding-agent': true });
    const decisive = [...mcpClientHits, ...piHits];
    expect(disallowedSpecifiers(rootSource)).toContain('@modelcontextprotocol/client');
    console.log(
      `[dist-subpath-closure] negative control: dist/index.js reports ${hits.length} hit(s); ` +
        `${decisive.length} decisive:\n${describeHits(decisive.slice(0, 6))}`,
    );
  });
});
