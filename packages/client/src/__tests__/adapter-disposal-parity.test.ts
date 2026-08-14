import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard: process-tree termination has exactly one authority
 * (`adapters/process-tree.ts`). Every runtime client must route through it,
 * and none may grow a private shortcut — a per-adapter `taskkill`, a bare
 * `child.kill()`, or a direct `process.kill()` would silently reintroduce
 * the direct-child-only disposal this module exists to prevent, on one
 * runtime only, where the shared tests would never see it.
 *
 * Source-level on purpose: an import graph assertion would still pass if a
 * client imported the module and then bypassed it.
 */

const RUNTIME_CLIENTS = [
  { runtime: 'pi', file: '../adapters/pi/rpc-client.ts' },
  { runtime: 'claude', file: '../adapters/claude/process-client.ts' },
  { runtime: 'codex', file: '../adapters/codex/process-runner.ts' },
];

const REQUIRED_IMPORTS = [
  'disposeOwnedProcessTree',
  'requestOwnedProcessTreeTermination',
  'withOwnedProcessTree',
];

/** Comments legitimately DISCUSS taskkill and signals; only executable code is constrained. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('runtime clients share one process-tree disposal authority', () => {
  it.each(RUNTIME_CLIENTS)('$runtime imports every process-tree entry point from ../process-tree', ({ file }) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    const importMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/process-tree';/);

    const importedNames = importMatch?.[1];
    expect(importedNames).toBeDefined();
    const imported = (importedNames ?? '').split(',').map((name) => name.trim());
    for (const required of REQUIRED_IMPORTS) expect(imported).toContain(required);
  });

  it.each(RUNTIME_CLIENTS)('$runtime has no private termination shortcut', ({ file }) => {
    const code = stripComments(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'));

    expect(code).not.toMatch(/taskkill/);
    expect(code).not.toMatch(/process\.kill\s*\(/);
    expect(code).not.toMatch(/spawnSync/);
    // `spawnFn(...)` for the runtime itself is expected; killing the child is not.
    expect(code).not.toMatch(/\bthis\.child\.kill\s*\(/);
  });
});
