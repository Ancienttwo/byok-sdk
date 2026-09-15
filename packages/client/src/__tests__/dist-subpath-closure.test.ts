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
 * KNOWN LIMITATION, stated rather than hidden: this is a regex scan over the
 * emitted text, not a parse. It cannot see a call assembled at runtime
 * (`globalThis['ev' + 'al']`), an indirect alias (`const f = Function; f(...)`),
 * or a specifier built from concatenation. It is a tripwire against the
 * realistic failure — an ordinary import landing in a guarded entry's graph and
 * silently dragging a code-generating dependency in — not a sandbox. The string
 * checks are correspondingly substring checks, deliberately blunt.
 *
 * NON-VACUITY: the same checker is run against `dist/index.js` at the bottom of
 * this file and MUST report hits. A checker that passes everything is worse
 * than no checker, so the root entry is the control that proves it can fail.
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
  { file: 'adapters/index.js', allowedSubstrings: ['pi-coding-agent', '@earendil-works'] },
  { file: 'agent-memory/index.js', allowedSubstrings: [] },
  { file: 'bin/byok-approval-mcp.js', allowedSubstrings: [] },
  { file: 'bin/byok-agent-message-mcp.js', allowedSubstrings: [] },
  { file: 'bin/byok-agent-memory-mcp.js', allowedSubstrings: [] },
  { file: 'bin/byok-agent-team-mcp.js', allowedSubstrings: [] },
];

/** The only bare specifiers a guarded entry may statically import. */
const ALLOWED_BARE_IMPORTS = new Set(['@byok-sdk/core', '@byok-sdk/protocol']);

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

describe.skipIf(!DIST_PRESENT)('the daemon-free dist sub-path closures', () => {
  for (const { file, allowedSubstrings } of GUARDED) {
    describe(`dist/${file}`, () => {
      const source = DIST_PRESENT ? readFileSync(path.join(DIST, file), 'utf8') : '';

      it('generates no code at runtime and carries no trace of the refused graph', () => {
        const hits = scanBundle(source, allowedSubstrings);
        expect(hits.length === 0 ? '' : `dist/${file}:\n${describeHits(hits)}`).toBe('');
      });

      it('statically imports only node builtins, @byok-sdk/core, @byok-sdk/protocol, or relative paths', () => {
        expect(disallowedSpecifiers(source)).toEqual([]);
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
    const decisive = hits.filter(
      (hit) => hit.rule.includes('@modelcontextprotocol/client') || hit.rule.includes('pi-coding-agent'),
    );
    expect(decisive.length).toBeGreaterThan(0);
    expect(disallowedSpecifiers(rootSource)).toContain('@modelcontextprotocol/client');
    console.log(
      `[dist-subpath-closure] negative control: dist/index.js reports ${hits.length} hit(s); ` +
        `${decisive.length} decisive:\n${describeHits(decisive.slice(0, 6))}`,
    );
  });
});
