import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDaemonConfig } from '../daemon/config-schema/validate';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const guide = readFileSync(new URL('../../../../docs/device-setup.md', import.meta.url), 'utf8');

describe('device setup guide authority', () => {
  it('keeps generated fields, migrations and complete error catalog current', () => {
    expect(() => execFileSync(process.execPath, ['scripts/docs/device-setup.mjs'], { cwd: root, encoding: 'utf8' })).not.toThrow();
  });

  it('validates every CLI JSON example with the CLI schema boundary', () => {
    const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(validateDaemonConfig(JSON.parse(example[1]!), { source: 'cli' }).issues).toEqual([]);
    }
  });

  it('validates the code-assembled embedded example with its source boundary', () => {
    const example = guide.match(/\/\/ example:embedded:start\nconst config: DaemonConfig = ([\s\S]*?);\n\/\/ example:embedded:end/);
    expect(example).not.toBeNull();
    const config = JSON.parse(example![1]!);
    expect(validateDaemonConfig(config, { source: 'embedded' }).issues).toEqual([]);
    expect(validateDaemonConfig(config, { source: 'cli' }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'distribution_owned', path: 'localAgentRelease' }),
    ]));
  });
});
