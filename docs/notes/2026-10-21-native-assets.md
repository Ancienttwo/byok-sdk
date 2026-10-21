# Native packaging evidence (#627)

Baseline: `742295a4a` (includes #617). The implementation reuses its Darwin helper
copy API and leaves its configuration contract intact. A unified build-time copy
entry adds the official `@koromix/koffi-win32-x64@3.2.0` archive. npm metadata and
`bun.lock` agree on SHA-512; the extracted addon SHA-256 is embedded in the SDK.
The runtime verifies bytes against that embedded digest before loading native code.
It does not trust a colocated manifest as an authority for replacement bytes.

Each adapter owns its explicit native asset root. SDK daemon-created adapters
receive the daemon option; custom adapters receive their own constructor option.
Installed dependency and explicit-root binding caches use distinct key namespaces.
No ambient process environment or mutable global configuration is used.

Cross-copy on macOS arm64 passed without executing the Windows addon. The separate
Windows SEA fixture relocates the executable and copied assets to a temporary root
outside node_modules; it starts a fake runtime and descendant, kills only the host,
and checks kernel Job Object cleanup. Removing assets must refuse admission and
complete child disposal. Windows execution is PENDING CI, not inferred from macOS.
No provider calls or secrets are involved. Windows memory support is unchanged.

The supported signing policy preserves exact official Windows addon bytes; product
signing applies to the enclosing executable/installer. Darwin helper signing uses
#617's existing verified Mach-O content policy. No arbitrary addon source is exposed.

Local build/typecheck and focused outcomes are recorded in the PR. Evidence logs
are under the task workspace `evidence-627/`; initial failures are retained.

The unchanged baseline Koffi indirect entry bundled as ESM outside node_modules
failed with `Cannot find the native Koffi module; did you bundle it correctly?`.
The patched focused run passed 30 tests across native asset, Job Object and owned
line process suites. The initial source-isolation regression was fixed by splitting
runtime loading from build-only metadata imports, without changing assertions.
Independent review identified and corrected an installed-cache key collision and
required an SDK-embedded addon digest instead of trusting a colocated manifest.

Final focused validation: 32 tests passed, including declared/streamed oversized
archive refusal before extraction and explicit-null cache isolation. Workspace
build/typecheck passed; the final client rebuild/typecheck and API/version gates
passed. YAML and diff checks passed. The fixture bundled as ESM and CJS, parsed,
and produced a SEA blob locally, but postject could not find the SEA sentinel in
the installed Homebrew Node. This is not a Windows execution result. No full local
suite was run; required broader and actual Windows gates are delegated to CI.
