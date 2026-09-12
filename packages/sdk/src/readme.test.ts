import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const namespaces = [...source.matchAll(/^export \* as (\w+) from /gm)].map(match => match[1]).sort();

describe('published umbrella README', () => {
  it('shows the full namespace surface in its consumer import', () => {
    const example = readme.match(/import \{([^}]+)\} from 'byok-sdk'/);
    expect(example).not.toBeNull();
    expect(example![1]!.split(',').map(name => name.trim()).sort()).toEqual(namespaces);
  });

  it('describes all seven dispatch namespaces', () => {
    expect(namespaces).toHaveLength(7);
    expect(readme).toContain('seven public dispatch packages');
    for (const name of namespaces) expect(readme).toContain(`- \`${name}\`:`);
  });

  it('keeps key custody outside the umbrella', () => {
    expect(namespaces).not.toContain('keys');
    expect(readme).toContain('`@byok-sdk/keys` is deliberately not exported or installed by this package.');
  });
});
