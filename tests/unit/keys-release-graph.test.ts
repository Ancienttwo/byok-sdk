import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

describe("keys release graph", () => {
  test("rejects the frozen registry stale-core edge", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/release/pack-and-smoke.mjs", "--self-test-stale-keys-edge"],
      { cwd: new URL("../..", import.meta.url), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "negative control detected the registry @byok-sdk/keys@0.2.0 -> @byok-sdk/core@0.4.2 stale edge",
    );
  });
});
