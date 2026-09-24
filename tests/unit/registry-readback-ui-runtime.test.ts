import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("registry readback package set", () => {
  const source = readFileSync(
    new URL("../../scripts/release/registry-readback.mjs", import.meta.url),
    "utf8",
  );
  const packageList = /const packages = \[([^\]]*)\];/.exec(source)?.[1] ?? "";
  const packages = [...packageList.matchAll(/'([^']+)'/g)].map((match) => match[1]);

  test("reads back the published ui-runtime package", () => {
    expect(packages).toContain("@byok-sdk/ui-runtime");
  });

  test("does not read back the packages 0.21.0 stopped publishing", () => {
    expect(packages).not.toContain("byok-sdk");
    expect(packages).not.toContain("@byok-sdk/testkit");
    expect(source).not.toContain("import('byok-sdk')");
  });
});
