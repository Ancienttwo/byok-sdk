import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../../vendor/rpiv-todo/2.8.0');
const manifest = JSON.parse(readFileSync(path.join(root, 'source-manifest.json'), 'utf8')) as {
  files: Array<{ path: string; upstreamSha256: string; vendoredSha256: string; delta?: string }>;
};
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('licensed private todo source boundary', () => {
  it('accounts for every source byte and rejects hidden additions', () => {
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
    expect(files).toEqual([...manifest.files.map(row => row.path), 'source-manifest.json', 'PROVENANCE.md'].sort());
    for (const row of manifest.files) {
      expect(hash(readFileSync(path.join(root, row.path))), row.path).toBe(row.vendoredSha256);
      if (!row.delta) expect(row.vendoredSha256, row.path).toBe(row.upstreamSha256);
    }
    expect(manifest.files.filter(row => row.delta).map(row => row.path).sort()).toEqual([
      'index.ts', 'state/i18n-bridge.ts', 'state/state-reducer.ts', 'todo-overlay.ts', 'tool/types.ts', 'view/format.ts',
    ]);
    expect(readFileSync(path.join(root, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2026 juicesharp');
  });

  it('proves the guarded index annotations erase to identical JavaScript', () => {
    for (const file of ['state/state-reducer.ts', 'todo-overlay.ts']) {
      const current = readFileSync(path.join(root, file), 'utf8');
      const original = file.startsWith('state/')
        ? current.replaceAll('state.tasks[idx]!', 'state.tasks[idx]')
        : current.replace('lines[last]!.replace', 'lines[last].replace');
      const upstream = original
        .replace('import type { TodoRenderPort as TUI } from "../../pi-tui/0.85.1/ports.js";\nimport { truncateToWidth } from "../../pi-tui/0.85.1/utils.js";',
          'import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";');
      expect(hash(upstream)).toBe(manifest.files.find(row => row.path === file)!.upstreamSha256);
      const result = spawnSync('bun', ['--eval', 'const t=new Bun.Transpiler({loader:"ts",target:"node"}); console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()).map(s=>t.transformSync(s))));'],
        { input: JSON.stringify([current, original]), encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const emitted = JSON.parse(result.stdout);
      expect(emitted[0]).toBe(emitted[1]);
    }
  });
});

it('keeps all six licensed upstream UI JavaScript files byte-identical', () => {
  let count = 0;
  for (const dir of ['pi-tui/0.85.1', 'get-east-asian-width/1.6.0']) {
    const base = path.resolve(root, '../../', dir);
    const source = JSON.parse(readFileSync(path.join(base, 'source-manifest.json'), 'utf8'));
    for (const row of source.files) {
      expect(hash(readFileSync(path.join(base, row.path))), row.path).toBe(row.vendoredSha256);
      if (row.path.endsWith('.js')) {
        count++;
        expect(row.delta).toBeUndefined();
        expect(row.vendoredSha256).toBe(row.upstreamSha256);
      }
    }
    expect(readFileSync(path.join(base, 'LICENSE'), 'utf8')).toContain('MIT');
  }
  expect(count).toBe(6);
});
