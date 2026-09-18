# Notes: wp1-smoke-observer-import-url

## Round-11 red evidence (pre-fix)
- Run 35218215293, job 105191678964 (npm release pack/install windows-latest lowpriv).
- Keys suite 4/4 green (owner-mismatch 506ms; warm-up + 120s keys budget + ProgramFiles ambient all holding).
- Keys chain stage green: "...explicit resolve/start capture and SDK host RPC passed; session/process cwd split and real reserved MCP handshake observed; prompts=0".
- Failure: `assert.equal(observed.status,0,observed.stderr||...)` at pi-launcher-smoke.mjs:459 — toolsObserver child stderr:
  `Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'c:'`
  Stack: throwIfUnsupportedURLScheme -> defaultLoadSync -> ModuleLoader.load -> ... -> run_main:123 (entry module load of the generated tools-observer.mjs).
- Root cause read from source: generated script lines `import {...} from ${JSON.stringify(piEntry)}` / `${JSON.stringify(sdkMcpExtension)}` (pi-launcher-smoke.mjs:218-219) embed raw absolute paths as ESM specifiers. POSIX accepts `/abs` specifiers; win32 parses `C:\` as protocol. Contrast: sealedEntry/todoEntry at :269/:278 already use `pathToFileURL(...).href`.
- Log dump: /tmp/wp1-r11-job.log (job 105191678964, ANSI-stripped).

## Fix
Two generated import specifiers wrapped in `pathToFileURL(<path>).href`. No product bytes, no budgets, no ambient changes.
