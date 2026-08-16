import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("registry readback umbrella contract", () => {
  test("expects the published uiRuntime namespace", () => {
    const source = readFileSync(
      new URL("../../scripts/release/registry-readback.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "['client','cloud','cloudDataplane','core','protocol','server','uiRuntime']",
    );
  });
});
