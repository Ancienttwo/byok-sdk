# Browser member local verification — #654 W4

The W4 browser page logic passed in Node on macOS. This is local implementation
verification; the deployed physical-device/browser acceptance rows remain open.
No deployment, real credential or paid runtime was used.

Commands from the repository root:

```sh
bun run build
bun examples/hosted-bot-collaboration-worker/src/build-member.mjs
bun run typecheck
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test src/browser-member.test.ts src/sealed-zero-hit.test.ts
bun run check:api-surface
bun run check:version-authority
```

All commands passed after syncing W3's unified Vitest dependency graph. The
affected suites reported 20 passing tests and 10 existing substrate/deployment-
gated skips. The new member suite ran all 18 cases:
genesis and non-extractable keys, two-way pairing verification, substituted MAC
refusal, inline and object C3 opening, private C1 submission and echoed C3,
multi-tab removal with a surviving member, chain rollback/approver refusal,
foreign tenant/task object refusal, public assets with authenticated APIs, the
method/authentication matrix, the production RPC allowlist, bounded base64
encoding, and the deployable asset build. The revocation case checks the absence
of the new-epoch package while distinguishing an old package still present.
All public-entry closure budgets equalled their measured bytes.

A separate local workerd smoke used Wrangler's existing `unstable_dev` API with
the tracked deployable entry and a private copy of the tracked deployment
template. It used built `_ops/p9/member-assets`, a synthetic loopback Hyperdrive
connection at an unused port, and a synthetic operator bearer. No database or
object endpoint was contacted by the application. Results with redirects disabled:

| Request without bearer | HTTP | Content type |
| --- | --- | --- |
| `/member` | 200 | `text/html` |
| `/member.js` | 200 | `text/javascript` |
| `/probe/call` | 401 | `text/plain` |
| `/member/ciphertext` | 401 | `text/plain` |

`assets.html_handling: "none"` is configured defensively against canonical URL
redirects when `/member` fetches `/index.html` from the asset binding. This smoke
used that setting and observed no redirect. A redirect-producing condition was
not reproduced; the earlier necessity claim was inferred, not measured. An
independent reviewer also observed no redirect under the pinned Wrangler default.
Static asset serving succeeded without token/storage secrets or a reachable
Postgres server. Wrangler emitted a local `Request.cf` lookup timeout and
supplied its normal local placeholder; the four application checks passed.

A review smoke also exercised 28 combinations across `/member` and `/member.js`:
GET/HEAD returned 200 with or without the bearer; POST/PUT/PATCH/DELETE/OPTIONS
returned 401 without it and 405 with it. No database connection was used.

CI path selection was checked independently for both
`src/build-member.mjs` and `src/fixtures/sealed-canary/member-page.ts`. The existing
workspace source rule (`src/` plus `.[cm]?[jt]sx?`) selects
`examples/hosted-bot-collaboration-worker`; its existing workspace-family rule
adds `dataplane`. The resulting jobs are **Affected workspace checks** and
**dataplane suites against real Postgres (fixed Node)**. The former runs the
complete example suite through `run-targeted.mjs`; the latter invokes the same
example test script directly. The new suite's build case invokes
`src/build-member.mjs` and checks its emitted HTML/JS, so these jobs execute both
the member asset build and its tests. No new CI mapping rule is needed.

The page logic tests use real WebCrypto and in-memory cloud member stores with
an authenticated fetch/JSON adapter and a scripted device-side cryptographic
peer. They do not run a browser DOM or the OS-custody daemon. W2b's separately
owned public-bundle comparison gate and `--stub-canary` mode, plus the owner's
staging and physical browsers, are prerequisites for deployed member evidence.
