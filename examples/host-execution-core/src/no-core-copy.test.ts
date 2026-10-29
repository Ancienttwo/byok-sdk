import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as executionCore from '@byok-sdk/server/execution-core';
import { expect, it } from 'vitest';

/**
 * #1106: K4 is published as `@byok-sdk/server/execution-core`. This example composes that API and keeps no copy of it:
 * no file redeclares an execution-core export, and no file repeats a run of execution-core source lines.
 */
const EXAMPLE = fileURLToPath(new URL('..', import.meta.url));
const CORE = fileURLToPath(new URL('../../../packages/server/src/execution-core/', import.meta.url));
const SELF = 'src/no-core-copy.test.ts';
const WINDOW = 3;

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.name === 'node_modules' ? [] : entry.isDirectory() ? files(join(dir, entry.name)) : /\.[cm]?ts$/.test(entry.name) ? [join(dir, entry.name)] : []);
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Lines that carry logic: imports, braces and short lines are shared by any two TypeScript files. */
const lines = (source: string) => code(source).split('\n').map(line => line.trim().replace(/\s+/g, ' '))
  .filter(line => line.length >= 24 && !/^(?:import|export \{|export type \{|\} from)\b/.test(line));
const windows = (source: string) => {
  const rows = lines(source);
  return rows.slice(0, Math.max(0, rows.length - WINDOW + 1)).map((_, index) => rows.slice(index, index + WINDOW).join('\n'));
};
/** Top-level declarations only; import specifiers and locals are not copies. */
function declared(source: string, names: ReadonlySet<string>): string[] {
  const body = code(source).replace(/^import\b[\s\S]*?\bfrom\s*['"][^'"]+['"];?/gm, '');
  return [...body.matchAll(/^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|function\*?|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1]!).filter(name => names.has(name));
}

const exported = new Set([...Object.keys(executionCore),
  ...[...readFileSync(join(CORE, 'index.ts'), 'utf8').matchAll(/export type \{([^}]*)\}/g)]
    .flatMap(match => match[1]!.split(',').map(name => name.trim()).filter(Boolean))]);
const coreWindows = new Set(files(CORE).flatMap(file => windows(readFileSync(file, 'utf8'))));
const exampleFiles = files(EXAMPLE).filter(file => relative(EXAMPLE, file).split('\\').join('/') !== SELF);

it('redeclares no execution-core export', () => {
  expect(exported.size).toBeGreaterThan(40);
  expect(exampleFiles.flatMap(file => declared(readFileSync(file, 'utf8'), exported).map(name => `${relative(EXAMPLE, file)}: ${name}`))).toEqual([]);
});

it(`repeats no run of ${WINDOW} execution-core source lines`, () => {
  expect(coreWindows.size).toBeGreaterThan(500);
  expect(exampleFiles.flatMap(file => windows(readFileSync(file, 'utf8')).filter(window => coreWindows.has(window))
    .map(window => `${relative(EXAMPLE, file)}: ${window.split('\n')[0]}`))).toEqual([]);
});

it('detects a copied declaration and a copied run', () => {
  const ledger = readFileSync(join(CORE, 'ledger.ts'), 'utf8');
  expect(declared(ledger, exported)).toContain('HostLedger');
  expect(windows(ledger).some(window => coreWindows.has(window))).toBe(true);
  expect(declared('interface Local { a: 1 }\nconst openHost = 1;', exported)).toEqual([]);
});
