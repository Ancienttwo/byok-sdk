# WP5 — Pi 0.99.2 scoped FFF revalidation

Status: **PASS; source frozen; notes ready**. This supersedes the old 0.99.1 scoped runtime acceptance. No production source, inherited upgrade file, lock, fixture, policy, Prepared or identity change was needed or made by this revalidation worker.

## Subject and scope

- Read updated contract and `wp5-0992-baseline.md` before execution. Subject is the parent's composition of all 23 inherited upgrade files plus existing FFF additions in `/Users/chris/Projects/byok-sdk-wt-pi-fff-local-search`.
- Actual installed direct runtime package readback: coding-agent, pi-ai and pi-agent-core all **0.99.2**. Actual explicit native-test interpreter: **Node v22.22.0**; Bun **1.4.2**.
- Nineteen inherited non-overlapping files were hashed against the supplied primary hashes: **19 checked, zero drift**. Four intended parent-owned composition overlaps are `bun.lock`, `docs/spec.md`, client `package.json` and `tasks/todos.md`.
- The prior read-only API comparison found only optional ToolNamespace instructions; the FFF facade uses unchanged public registration / flag / readonly-history / shutdown APIs. Compilation and runtime results below confirm no scoped implementation adaptation was required.

## Commands and actual outcomes

Full logs: `/tmp/byok-fff-wp5-logs/`. Commands run only on the combined source worktree; no full repository suite, canonical root verification or release-pack command ran here.

| Command | Cwd | Exit / evidence |
| --- | --- | --- |
| `bun run build` | `packages/client` | **0**; sealed build preserved 64 existing dist digests and excluded the user-schema compiler subgraph; adapter-entry and agent-memory-entry gates passed |
| `bun run typecheck` | `packages/client` | **0**; source tsc and vendor tsc passed |
| fresh `/tmp/bf52.XXXXXX` TMPDIR, explicit `BYOK_REQUIRE_BUN=1`, `BYOK_TEST_BUN_BIN=/Users/chris/.bun/bin/bun`, `bun run test -- src/__tests__/pi-fff.test.ts src/__tests__/pi-rpc-host.test.ts src/__tests__/pi-permission-mapping.test.ts` | `packages/client` | **0**; **3 files, 29 tests passed** |
| fresh `/tmp/bf522.XXXXXX` TMPDIR, same explicit Bun env, `/tmp/byok-fff-node22/node_modules/node/bin/node ../../node_modules/vitest/vitest.mjs run src/__tests__/pi-fff.test.ts` | `packages/client` | **0**; **1 file, all 4 real native probes passed**; child process.execPath is the actual Node 22.22.0 interpreter |
| `/tmp/byok-fff-node22/node_modules/node/bin/node --test scripts/release/pack-and-smoke.test.mjs` | worktree root | **0**; **5 tests passed, 0 skipped**, using inherited 0.99.2 identity/integrity fixtures |
| `git diff --check` | worktree root | **0** |

Native probes cover actual FFF filename/content search, ignored-file negative search, native/FFF external absolute-path parity, poisoned global/env/history authority, fixed tool names and unchanged builtin schemas, default / explicit / deny / empty / readonly registration, two separate native session DBs, pending-operation shutdown, unbound disposal and exact missing-library startup failure with cleanup. No mocked finder is used as the acceptance proof.

Observed native platform remains macOS arm64. These results make no native Bun/Linux/Windows runtime claim.

## Frozen FFF source hashes

```json
{
  "packages/client/package.json": "9ed9fd71ced2774cb7029861a67836b2ef1ca98b5b0afb70cf075231dbffec92",
  "bun.lock": "2ff7024405b9d8e7d25d0d978f72f166c7a33f8042007b2b1541ac841dbf618c",
  "packages/client/tsup.config.ts": "5cf62b86c8c56c898e94883575f18ad39cb61ab902d7c80897913036b2f560a4",
  "packages/client/tsup.sealed.config.ts": "3a61a1ea71853b95e9a981055b38771d2251827d5afa3bb3f4ef503cb966c0e6",
  "packages/client/src/bin/pi-extension-factories.js": "cf6d183799b077a049a3057e9c220d6d64fa0b8873d578318e22262bfede818a",
  "packages/client/src/bin/pi-extension-factories.d.ts": "fb949580e81dd3b6746831b7d3f1443c36b31ece4a99622e08f9e7001318ed56",
  "packages/client/src/adapters/pi/fff-extension.ts": "11173fca3937fa205b70f38e4577f4b7fdaf0c0681874a7bc78749a5a18ea71e",
  "packages/client/src/bin/pi-rpc-host.ts": "eb60d5bd78942427fdb5d9a6825f59782335c62e836669c280d86baeae8440cf",
  "packages/client/src/__tests__/pi-fff.test.ts": "a49aa19962942b05b88b189989bc12ef819b32629d74f5e74315d01396df6661"
}
```

## Handoff

Scoped source/testing is complete and frozen, with this note finalized before handoff. Parent owns remaining metadata freeze, exact clean candidate snapshot, canonical whole-repository checks, installed release-pack convergence and independent final review. No commit, push, publish or main-worktree edit occurred.
