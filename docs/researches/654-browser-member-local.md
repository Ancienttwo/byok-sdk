# Browser member local verification — #654 W4

The W4 browser page logic passed in Node on macOS. This is local implementation
verification; the deployed physical-device/browser acceptance rows remain open.
No deployment, real credential or paid runtime was used.

Commands from the repository root:

```sh
bun run build
bun examples/hosted-bot-collaboration-worker/build-member.mjs
bun run typecheck
bun run --filter @byok-sdk/example-hosted-bot-collaboration-worker test src/browser-member.test.ts src/sealed-zero-hit.test.ts
bun run check:api-surface
bun run check:version-authority
```

All commands passed. The affected suites reported 12 passing tests and 10
existing substrate/deployment-gated skips. The new member suite ran all 10 cases:
genesis and non-extractable keys, two-way pairing verification, substituted MAC
refusal, inline and object C3 opening, private C1 submission and echoed C3,
multi-tab removal with a surviving member, chain rollback/approver refusal,
foreign tenant/task object refusal, and public assets with authenticated APIs.
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

`assets.html_handling: "none"` is necessary because `/member` fetches
`/index.html` from the asset binding and must receive HTML without a canonical
URL redirect. Static asset serving succeeded without token/storage secrets or a
reachable Postgres server. Wrangler emitted a local `Request.cf` lookup timeout
and supplied its normal local placeholder; the four application checks passed.

The page logic tests use real WebCrypto and in-memory cloud member stores with
an authenticated fetch/JSON adapter and a scripted device-side cryptographic
peer. They do not run a browser DOM or the OS-custody daemon. W2b's separately
owned public-bundle comparison gate and `--stub-canary` mode, plus the owner's
staging and physical browsers, are prerequisites for deployed member evidence.
