# Plan: wp1-smoke-observer-import-url (WP1 round 12)

## Why
Round 11 (35218215293, job 105191678964) moved past every prior blocker (keys 4/4 green, bash detection cleared, keys chain green) and failed only at the tools-observer stage: the smoke generates `tools-observer.mjs` with STATIC import specifiers taken from raw absolute paths (`piEntry`, `sdkMcpExtension`, generated at pi-launcher-smoke.mjs:218-219). On win32 an ESM specifier `C:\...` parses as URL protocol `c:` -> `ERR_UNSUPPORTED_ESM_URL_SCHEME` at module load. On POSIX `/abs/path` resolves as a file URL, which is why every other leg and all prior darwin runs are green. The smoke's own sealed/todo probes (:269/:278) already use the correct idiom `pathToFileURL(...).href`; the observer entries predate it.

## Task Breakdown
1. [ ] pi-launcher-smoke.mjs:218-219: wrap both generated import specifiers with `pathToFileURL(<path>).href` (idiom already used at :269/:278; `pathToFileURL` already imported at :8). No other lines change.
2. [ ] tasks/todos.md timestamp + ledger entry.
3. [ ] Local gates: parse check, specifier greps, darwin packed smoke (real observer stage on POSIX), diff check.
4. [ ] Commit + push; Windows CI round 12 is the behavioral gate.

## Verification
- `node --check scripts/release/pi-launcher-smoke.mjs`
- specifier greps (URL form present, raw form absent)
- `node scripts/release/pack-and-smoke.mjs --out-dir /tmp/wp1-r12-localpack` (darwin full smoke, observer stage included)
- `git diff --check`
- Windows CI round 12 (npm-release-pack windows lowpriv lane)

## Rollback
Revert this slice's single commit restores 26651ba2 bytes.
