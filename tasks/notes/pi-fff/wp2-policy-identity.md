# WP2 policy and native identity trace

Status: COMPLETE (read-only source/npm trace); no clean SDK install claim.

- Exact Pi 0.99.1 npm artifact registry refresh filters both builtin and extension names by allowedToolNames/excludedToolNames; setActiveToolsByName cannot activate missing/hidden registry entries. Evidence: /tmp/byok-pi-0.99.1/package/dist/core/agent-session.js:2740 and :1069.
- Host checks policy-derived delegated flags against bound config: packages/client/src/bin/pi-rpc-host.ts:121; session passes exact tools/excludeTools/noTools: packages/client/src/bin/pi-session-runtime.ts:57. Mapping: packages/client/src/adapters/pi/permission-mapping.ts:83. Preserve explicit empty/deny/readonly behavior.
- Exact FFF 0.11.0: src/index.ts:671 registers tools; :715 appends active tools; :772 prepares session and restores stored fff-mode; :812 session_start; :857 shutdown. tools-only names are fffind/ffgrep (multi-grep activation is conditional in published code, verify actual registration rather than README alone).
- Fixed environment tools-only is insufficient because restored fff-mode entry can choose override, replacing builtin grep/find. WP3 public-API proof must prevent this authority change.
- FFF factory initially reads global config; paths.ts:27 can reuse Neovim databases. SDK config/database ownership remains a feasibility gate.
- FFF supports absolute, ~ and external-root auxiliary search. Existing native Pi tools are not a filesystem sandbox; no confinement claim is made solely from cwd. Compare existing product semantics before changing path access.
- implementation-identity measures declared runtime artifacts/interpreter/assets, not all npm dependency/native loader mappings: packages/implementation-identity/src/identity.ts:44. Ordinary FFF dependencies require clean install/native resolution readback, not a false attestation claim. Prepared/identity/compiler source is outside this slice.
- Runtime package manifest peers: Pi coding-agent, pi-tui and @sinclair/typebox. Bundled TS plus external native packages must pass actual installed smoke. Existing release smoke: scripts/release/pack-and-smoke.mjs:147 and :487; it does not yet assert FFF platform binaries.
- Existing tests: packages/client/src/__tests__/pi-permission-mapping.test.ts and pi-rpc-host.test.ts. Final candidate also requires root checks and release-pack.

Dispositions: WP2 complete; WP3 feasibility proof dispatched before production edits; WP4 final review pending implementation.
