import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyModelRouteChange,
  createModelRouteDraft,
  modelRouteSubmission,
  modelRouteView,
  type ModelRouteChange,
  type ModelRouteContext,
  type ModelRouteDraft,
} from './model-route';

// Each file carries its own small catalog, so a catalog regeneration does not
// move these vectors. A non-TypeScript Host can replay the same files.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/model-route');

interface Vector {
  readonly name: string;
  readonly draft: ModelRouteDraft | null;
  readonly change: ModelRouteChange | null;
  readonly expect: { readonly draft: unknown; readonly view: unknown; readonly submission: unknown };
}

const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();

describe('model-route fixture vectors', () => {
  it('has the fixture files', () => {
    expect(files).toEqual(['host-policy.json', 'stored-capabilities.json', 'stored-secret.json', 'vendor-and-model.json']);
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    const context: ModelRouteContext = { catalog: fixture.catalog, stored: fixture.stored, policy: fixture.policy };
    for (const vector of fixture.vectors as Vector[]) {
      it(`${file}: ${vector.name}`, () => {
        const draft = vector.draft === null
          ? createModelRouteDraft(context)
          : applyModelRouteChange(vector.draft, vector.change!, context);
        expect(draft).toEqual(vector.expect.draft);
        expect(modelRouteView(draft, context)).toEqual(vector.expect.view);
        expect(modelRouteSubmission(draft, context)).toEqual(vector.expect.submission);
      });
    }
  }
});
