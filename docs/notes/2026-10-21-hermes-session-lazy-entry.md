# Hermes session static-entry boundary

PR 639 at `5478282b0e55100eac85751bc2758d1e271037c0` adds 3,175 bytes above its root static-entry budget. Integrating main `4f6ccbf100c912e50114eab2997957d0412b486b` preserves that excess: 2,066,452 / 2,063,277 bytes. The local integration is recorded separately from this optimization.

The private HermesSession implementation and its projection now load at the existing asynchronous start allocation point, after manifest/cwd checks and before session/profile/process allocation. Constructor validation remains synchronous. The public API and exports remain unchanged. Runtime error and ACP constructors, profile cleanup and gateway identity functions are supplied by the calling entry, preserving runtime identities and resource ownership.

This is deferred loading, not total package-size reduction. The root static closure becomes 2,057,425 bytes (9,027 fewer; existing budget 2,063,277), adapters becomes 376,113 / 415,785 bytes, and the new private closure is inventoried at exactly 12,529 bytes with no third-party imports or code generation. No existing budget is increased.

Validation: client build, typecheck, public client declaration golden and complete closure inventory passed. Existing Hermes adapter/home tests passed (25); custody tests passed (4) after building their required keys launcher artifact. The first sandboxed run failed socket setup with EPERM; the initial normal run lacked that keys dist artifact. Neither failure was hidden or treated as a product assertion change.

The build-integrated private-entry smoke checks synchronous construction, both public entries' RuntimeExecutionFailure/RuntimeDisposalFailure identities, retained ownership after cleanup refusal, and successful cleanup retry. It also passed against an extracted npm tarball with matching workspace dependency links; this is not a clean registry-install qualification. Bun resolved and bundled the extracted package's private imports-map entry. No actual SEA executable or Windows runtime qualification is claimed by these local smoke checks; affected packaging/platform CI remains required.

Source Vitest and TypeScript aliases target the same private source module; installed Node uses the shipped imports mapping. Selector contracts admit only the exact new private mapping/build smoke suffix and reviewed file paths; unrelated imports, exports, dependencies and commands continue to fail closed. No full test matrix or release dispatch was run.
