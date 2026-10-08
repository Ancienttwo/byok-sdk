import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePiSubagentSpawn } from '../subagents/spawn';
import { BYOK_SDK_HELPER_SUBCOMMAND } from '../sdk-reserved-helper-host';

const argv1 = process.argv[1];
const roots: string[] = [];
afterEach(async () => {
  process.argv[1] = argv1!;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('resolvePiSubagentSpawn', () => {
  it('re-enters the running entry script through the SDK helper prefix', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'byok-subagent-spawn-')));
    roots.push(root);
    const entry = path.join(root, 'product entry.js');
    await fs.writeFile(entry, '');
    process.argv[1] = entry;
    expect(resolvePiSubagentSpawn('pi-subagent-print', ['-p', 'task'])).toEqual({
      command: process.execPath,
      args: [entry, BYOK_SDK_HELPER_SUBCOMMAND, 'pi-subagent-print', '-p', 'task'],
    });
    expect(resolvePiSubagentSpawn('pi-subagent-runner', ['/tmp/config.json']).args)
      .toEqual([entry, BYOK_SDK_HELPER_SUBCOMMAND, 'pi-subagent-runner', '/tmp/config.json']);
  });

  it('omits the entry for a single-file executable', () => {
    for (const value of [process.execPath, path.join(os.tmpdir(), 'byok-missing-entry', 'cli.js'), '']) {
      process.argv[1] = value;
      expect(resolvePiSubagentSpawn('pi-subagent-print', ['-p'])).toEqual({
        command: process.execPath,
        args: [BYOK_SDK_HELPER_SUBCOMMAND, 'pi-subagent-print', '-p'],
      });
    }
  });
});
