import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('@byok-sdk/ui-runtime package boundary', () => {
  it('has only BYOK workspace runtime dependencies and no React or Node runtime surface', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      '@byok-sdk/cloud': 'workspace:*',
      '@byok-sdk/protocol': 'workspace:*',
    });
    const source = [
      readFileSync(path.join(packageRoot, 'src/index.ts'), 'utf8'),
      readFileSync(path.join(packageRoot, 'src/timeline.ts'), 'utf8'),
      readFileSync(path.join(packageRoot, 'src/types.ts'), 'utf8'),
    ].join('\n');
    expect(source).not.toMatch(/from ['"](?:node:|react|react-dom)/);
    expect(source).not.toMatch(/\b(?:fetch|WebSocket|EventSource|localStorage|indexedDB)\b/);
  });

  it('uses the cloud/protocol authorities instead of copying their schemas', () => {
    const source = readFileSync(path.join(packageRoot, 'src/timeline.ts'), 'utf8');
    expect(source).toContain('TimelineEventSchema');
    expect(source).toContain('isKnownAgentEvent');
    expect(source).not.toContain('partitionAgentEvents');
  });
});
