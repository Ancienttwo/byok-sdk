# Browser vector runner (#654, layer V)

From the repository root, install the locked workspace dependencies with `bun ci`
and run `bun run build`. Then:

```sh
cd examples/hosted-bot-collaboration-worker
bun ../../node_modules/playwright/cli.js install chromium firefox webkit
bun run test:browser
```

On macOS/Linux, optionally set `PLAYWRIGHT_BROWSERS_PATH` before both the install
and test commands to keep the downloads on another volume:

```sh
export PLAYWRIGHT_BROWSERS_PATH=/Volumes/D/cache/ms-playwright
```

On Windows PowerShell, use `$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\cache\ms-playwright'`
with a directory on that device. Leave it unset to use Playwright's default cache.

On Linux, Playwright may also need system libraries (`install --with-deps`).
The command runs both sealed-payload and member-rules vector checkers in
headless Chromium, Firefox (Gecko), and WebKit. A missing engine or a vector
mismatch fails the run; no engine is skipped. The browser test has an explicit
include in its own config, so the ordinary Node test command does not collect it.

The Node oracle files use `node:crypto` and filesystem-based golden generation.
This adapter imports their unchanged shared checkers and the same checked-in
golden JSON, as the Bun leg does. It never regenerates golden files. The shared
checkers include the receiver rejection cases, member-chain checks, scope signer
and shred rules; they throw on any mismatch.

Each engine prints its actual `navigator.userAgent` and the installed Playwright
version before testing, followed by the counts returned by each checker on
success. Preserve the full output (including Vitest's per-engine results), the
commit, device/OS, command and UTC time for each acceptance run. These vectors
exercise the P-256 sealed-payload rules; they do not claim Ed25519 device-proof or
member-page acceptance.

This is an operator command, kept outside the baseline CI test command. The
acceptance plan calls for layer V on mac-pro and win-ci; run all three engines
on each device and record the rows separately. Playwright's WebKit build on
Windows is separate evidence from system Safari on macOS. The member page is
layer M with its own acceptance procedure. A local run alone does not complete
#654's physical-device and browser acceptance.

The browser tooling is pinned in the private root workspace's devDependencies;
root and example Vitest are pinned to the matching version. This keeps browser
and Node tests, including cross-workspace test helpers, in the same Vitest peer
context. The Node suite includes a check that its Vitest module resolves to the
same physical package as the root. Playwright and playwright-core have no install
lifecycle hooks, so `bun ci`/`bun install` does not download browsers; only the
explicit install command above downloads them. No published package gains a
runtime dependency, and the runner changes no public API.
