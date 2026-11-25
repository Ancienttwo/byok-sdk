import { describe, expect, open, test } from "nsh/test";

describe("MarkdownView links (ADR-052 D2)", () => {
  test("a pressed link opens only through the links.ts allowlist: allowed https opens, other hosts and non-https are refused", async () => {
    const app = await open("./links.fixture.tsx", { platform: "macos", width: 800, height: 400 });
    await app.waitFor("text:docs");

    await app.press("text:other");
    await app.waitFor("text:refused https://other.byok.test/guide");
    await app.press("text:plain");
    await app.waitFor("text:refused http://docs.byok.test/guide");
    await app.press("text:script");
    await app.waitFor("text:refused javascript:alert(1)");
    expect(app.openedUrls()).toEqual([]);

    await app.press("text:docs");
    await app.waitFor("text:opened https://docs.byok.test/guide");
    expect(app.openedUrls()).toEqual(["https://docs.byok.test/guide"]);
  });
});
