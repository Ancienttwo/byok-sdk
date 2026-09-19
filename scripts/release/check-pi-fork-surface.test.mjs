import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectForkSurface, FORK_ONLY_SUBPATHS, RECORDED_INVENTORY } from './check-pi-fork-surface.mjs';

function withFixture(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-fork-surface-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('detects a fork-only import and records its line', () => {
  withFixture(
    {
      'packages/client/src/example.ts': [
        "import { x } from '@byok-sdk/contracts';",
        "import type { Prepared } from '@earendil-works/pi-coding-agent/prepared-session-input';",
      ].join('\n'),
    },
    (root) => {
      const inventory = collectForkSurface(root);
      assert.deepEqual(Object.keys(inventory), ['packages/client/src/example.ts']);
      assert.equal(inventory['packages/client/src/example.ts'][0].line, 2);
      assert.equal(inventory['packages/client/src/example.ts'][0].specifier, FORK_ONLY_SUBPATHS[0]);
    },
  );
});

test('ignores official subpaths, vendored trees and non-source files', () => {
  withFixture(
    {
      'packages/client/src/official.ts': "import { createAgentSession } from '@earendil-works/pi-coding-agent';\nimport { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';",
      'packages/client/vendor/pi-subagents/index.ts': "import type { X } from '@earendil-works/pi-coding-agent/rpc-types';",
      'packages/client/src/notes.md': '@earendil-works/pi-coding-agent/rpc-types',
      'packages/client/node_modules/dep/index.js': "require('@earendil-works/pi-coding-agent/rpc-types');",
    },
    (root) => {
      assert.deepEqual(collectForkSurface(root), {});
    },
  );
});

test('the recorded inventory still describes this repository', () => {
  const inventory = collectForkSurface();
  const recorded = new Set(Object.keys(RECORDED_INVENTORY));
  const found = new Set(Object.keys(inventory));
  assert.deepEqual([...found].filter((file) => !recorded.has(file)), [], 'unrecorded fork-only import sites');
  for (const [file, hits] of Object.entries(inventory)) {
    assert.ok(hits.length <= RECORDED_INVENTORY[file], `${file} grew beyond the recorded count`);
  }
});
