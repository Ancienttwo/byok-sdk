/**
 * Static boundaries for sealed provisioning (plan §1, S1 rules): keys adds no
 * network listener, never imports the dispatch packages, and never logs.
 */
import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const SRC = new URL('./', import.meta.url);

function shippedSources(directory: URL = SRC, prefix = ''): Array<{ path: string; text: string }> {
  const files: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'fixtures') continue;
      files.push(...shippedSources(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    files.push({ path: `${prefix}${entry.name}`, text: readFileSync(new URL(entry.name, directory), 'utf8') });
  }
  return files;
}

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

describe('keys custody boundaries', () => {
  const sources = shippedSources();

  it('opens no network listener', () => {
    expect(sources.filter((file) => /\bcreateServer\b|\.listen\(/u.test(code(file.text))).map((file) => file.path)).toEqual([]);
  });

  it('never imports client, protocol, server or cloud', () => {
    expect(sources.filter((file) => /from '@byok-sdk\/(?:client|protocol|server|cloud)/u.test(code(file.text))).map((file) => file.path)).toEqual([]);
  });

  it('never writes to the console', () => {
    expect(sources.filter((file) => /\bconsole\./u.test(code(file.text))).map((file) => file.path)).toEqual([]);
  });
});
