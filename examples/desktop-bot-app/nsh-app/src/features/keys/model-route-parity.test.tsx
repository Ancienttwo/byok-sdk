import {
  applyModelRouteChange,
  createModelRouteDraft,
  modelRouteSubmission,
  modelRouteView,
  type ModelRouteChange,
  type ModelRouteContext,
  type ModelRouteDraft,
} from "@byok-sdk/keys/model-route";
import { describe, expect, test } from "nsh/test";
import hostPolicy from "../../../../../../packages/keys/src/fixtures/model-route/host-policy.json";
import storedCapabilities from "../../../../../../packages/keys/src/fixtures/model-route/stored-capabilities.json";
import storedSecret from "../../../../../../packages/keys/src/fixtures/model-route/stored-secret.json";
import vendorAndModel from "../../../../../../packages/keys/src/fixtures/model-route/vendor-and-model.json";

interface FixtureVector {
  readonly name: string;
  readonly draft: ModelRouteDraft | null;
  readonly change: ModelRouteChange | null;
  readonly expect: {
    readonly draft: unknown;
    readonly view: unknown;
    readonly submission: unknown;
  };
}

interface ModelRouteFixtureFile {
  readonly catalog: ModelRouteContext["catalog"];
  readonly stored: ModelRouteContext["stored"];
  readonly policy: ModelRouteContext["policy"];
  readonly vectors: readonly FixtureVector[];
}

const FIXTURE_FILES: ReadonlyArray<readonly [string, ModelRouteFixtureFile]> = [
  ["host-policy.json", hostPolicy as unknown as ModelRouteFixtureFile],
  ["stored-capabilities.json", storedCapabilities as unknown as ModelRouteFixtureFile],
  ["stored-secret.json", storedSecret as unknown as ModelRouteFixtureFile],
  ["vendor-and-model.json", vendorAndModel as unknown as ModelRouteFixtureFile],
];

describe("@byok-sdk/keys/model-route 30-vector QuickJS parity", () => {
  // ADR-052 D2 / #2461 parity (b): the vectors run under Policy::harden, the release policy. `nsh test` loads test
  // files as `Bundle::bytecode`, whose `Policy::default()` hardens; a development policy would fail this first.
  test("runs under Policy::harden: no eval, no Function constructor, frozen shared prototypes", () => {
    expect(typeof (globalThis as { eval?: unknown }).eval).toBe("undefined");
    expect(() => new Function("return 1")).toThrow("the Function constructor is disabled");
    expect(Object.isFrozen(Object.prototype)).toBe(true);
    expect(Object.isFrozen(Array.prototype)).toBe(true);
  });

  test("contains exactly 30 fixture vectors across the four files", () => {
    const total = FIXTURE_FILES.reduce((sum, [, fixture]) => sum + fixture.vectors.length, 0);
    expect(total).toBe(30);
  });

  for (const [fileName, fixture] of FIXTURE_FILES) {
    const context: ModelRouteContext = {
      catalog: fixture.catalog,
      stored: fixture.stored,
      policy: fixture.policy,
    };

    for (const vector of fixture.vectors) {
      test(`${fileName}: ${vector.name}`, () => {
        const draft =
          vector.draft === null
            ? createModelRouteDraft(context)
            : applyModelRouteChange(vector.draft, vector.change!, context);
        expect(draft).toEqual(vector.expect.draft);
        expect(modelRouteView(draft, context)).toEqual(vector.expect.view);
        expect(modelRouteSubmission(draft, context)).toEqual(vector.expect.submission);
      });
    }
  }
});
