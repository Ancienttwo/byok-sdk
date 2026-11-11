# Desktop D0: SEA Host inside an empty Electron shell (packaging probe)

Issue: #1803 (parent #1499). Date: 2026-11-11. Base: `train/next-minor` with #1816 (A1) stacked, head `34964e373`.

The probe lives outside the repository (`/Volumes/D/byok-desktop-probe/`, deleted after this note).
Only this note and the Linux CI steps in the `desktop` lane are committed.

## Summary

| Question | macOS arm64 (this machine) | Windows x64 | Linux x64 |
| --- | --- | --- | --- |
| Unpacked size | 439 MiB (`.app`) | Asset root measured only: 33.1 MiB without the SEA | Not measured |
| Installer size | DMG 166 MiB, ZIP 161 MiB | Not built | Not built |
| Pi foreground dispatch from `resources/host/` | **Proven** (packaged, signed app) | Open (win-ci slot) | Open (A7) |
| Memory helper starts from `resources/host/` | **Proven** (`agent-memory-fs/darwin-arm64 serve` ran; `memory_recall` returned) | Open (win-ci slot) | Not applicable (no helper on Linux) |
| Background subagent -> `pi_background_unavailable` (R2) | **Proven** (packaged, signed app) | Open (win-ci slot) | Open (A7) |
| Nested signing | **Ad-hoc dry run proven**: `codesign --verify --deep --strict` passes; Developer ID, notarize and staple are owner steps | `koffi.node` matches the pin before signing; electron-builder's default signs only `.exe` (static read); post-signing hash open (win-ci slot) | No OS signing |
| libsecret / AppArmor | - | - | libsecret round trip and fail-closed proven in a container; the GitHub runner result comes from the `desktop` lane; packaged-app AppArmor stays open |

## Setup

- Machine: macOS 26.5 (25F71), arm64. Node for the SEA: official `node-v24.22.1-darwin-arm64` (`.node-version`; Homebrew Node has no SEA fuse).
- Electron 45.3.0, electron-builder 26.18.0 (its bundled `@electron/fuses` 1.8.0), installed with Bun into the probe directory; Electron and electron-builder caches on `/Volumes/D`.
- Host: `examples/packaging/embedded-host-fixture.ts` copied to the probe and changed in three places (below), bundled with `byokSdkPackaging({ format: 'sea' })` to CJS, injected into a SEA (`--macho-segment-name NODE_SEA`, strip, inject, ad-hoc re-sign), with `copySdkPackagingAssets({ platform: 'darwin', arch: 'arm64' })` beside it in `host-ship/`. That is the same recipe as `examples/packaging/embedded-host-smoke.mjs --format sea`, which also passed unchanged on this machine first (`[embedded-host-smoke] sea on darwin-arm64 passed (1348 SDK asset files)`).
- Shell: an empty Electron app with no window. `main.js` spawns `process.resourcesPath/host/host host`, with `NODE_PATH`, `NODE_OPTIONS`, `PI_PACKAGE_DIR`, `BYOK_PI_BIN` and `ELECTRON_RUN_AS_NODE` removed, writes the Host's report to `BYOK_PROBE_REPORT`, and exits with the Host's code.
- electron-builder config: `extraResources: [{ from: '../host-ship', to: 'host' }]` (outside the asar), `asar: true`, `mac.target: [dmg, zip]`, `mac.identity: null`, and the §1.7 fuses through `electronFuses` (RunAsNode, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments off; OnlyLoadAppFromAsar, EnableEmbeddedAsarIntegrityValidation, EnableCookieEncryption on).

Fixture changes for the probe:

1. The model endpoint answers the first request of a task that offers `memory_recall` (and not `subagent`) with a `memory_recall({ path: 'MEMORY.md' })` tool call, and the first request that offers `subagent` with `subagent({ agent: 'worker', task, async: true, context: 'fresh' })`. Every other request gets the plain reply. Tool results are recorded.
2. A second dispatch with no `dispatchSelection`, so Pi uses its own auth store: `PI_CODING_AGENT_DIR` points at a probe-owned agent dir whose `models.json` names the in-process endpoint with a synthetic `apiKey`, passed through `runtimes.pi.runtimeEnvironment: { pass: ['PI_CODING_AGENT_DIR'] }` (R4, #1768).
3. The report adds `refused`, `toolResults`, `offeredTools` and `execPath`; `ok` requires the first task complete with the reply and the refusal seen.

No real provider key and no paid model call: both lanes talk to an OpenAI-compatible endpoint inside the Host process.

## macOS arm64 results

### Pi foreground, memory helper and R2 from `resources/host/`

Packaged, ad-hoc signed app (after the nested signing below):

```
$ BYOK_PROBE_REPORT=report-signed.json "BYOK Desktop Probe.app/Contents/MacOS/BYOK Desktop Probe"; echo exit=$?
exit=0   (23.4 s wall)
host  .../BYOK Desktop Probe.app/Contents/Resources/host/host  code 0
{ ok: true, refused: true, state: 'Complete', agentMemoryMcp: 'admitted',
  execPath: '.../BYOK Desktop Probe.app/Contents/Resources/host/host', helperHost: 'executable',
  modelRequests: 4 x 'POST /v1/chat/completions' }
toolResults[0]: {"path":"MEMORY.md","revision":"sha256:e3b0c442...","content":""}
toolResults[1]: pi_background_unavailable: Node SEA cannot run background Pi subagents or workflows:
  pi-subagents 0.87.0 uses resolveNodeExecutable for its background runner and fork on process.execPath
  for its workflow supervisor; a SEA binary cannot stand in for Node. Foreground non-workflow subagents
  work; use a Bun-compiled product with shipped assets for background subagents and workflows.
```

Processes sampled with `ps` during a run of the same SEA from `host-ship/` (`<ship>` is the asset root; inside the app it is `Contents/Resources/host`):

```
<ship>/host __byok_sdk_helper pi-rpc --config-digest=... --config .../rpc-launch.json ...
<ship>/host __byok_sdk_helper agent-memory-mcp .../byokagentmemory-context.json
<ship>/host pi-provider-launcher --pi-bin <ship>/host --profile-db .../providers.sqlite ...
<ship>/native/agent-memory-fs/darwin-arm64 root-barrier
<ship>/native/agent-memory-fs/darwin-arm64 serve
```

What this proves:

- Pi starts through the SDK helper re-entry of the SEA (`helperHost: 'executable'`), and both Pi lanes complete inside the packaged app.
- The Agent memory helper is admitted, starts from the shipped asset root and serves a real `memory_recall`, after the product re-signed it (policy `product-resigning-allowed`).
- R2: a background subagent request is refused at `tool_call` with `pi_background_unavailable`, and the Turn still completes. The model sees the refusal as the tool result.

Finding for A6/A7: **under a pinned BYOK keys profile, Pi does not register the `subagent` tool at all.** `packages/client/src/bin/pi-rpc-host.ts:280` loads pi-subagents only when `credentialSource !== 'keys-profile'`. The first dispatch (keys launcher, `dispatchSelection` pinned) was offered `read, bash, edit, write, web_search, source_check, fetch_content, get_search_content, todo, memory_recall, memory_save`. The second (Pi auth store) also got `subagent, contact_supervisor, bg_wait, subagent_supervisor`. So a desktop Bot on a BYOK key never reaches the R2 refusal; R2 only shows on the Pi-auth-store lane. The A7 packaged smoke must use that lane to assert R2, as this probe does.

### Sizes

`du -sk`, unpacked `.app` after packaging:

| Part | KiB | Note |
| --- | ---: | --- |
| `BYOK Desktop Probe.app` | 449,864 | 439 MiB |
| `Contents/Frameworks/Electron Framework.framework` | 257,048 | |
| `Contents/Resources/host` | 184,104 | 1,349 files |
| `host/host` (SEA) | 147,816 | official Node 122,545,856 B + SEA blob 29,688,908 B |
| `host/pi` | 28,968 | `pi-subagents/` 26,632 |
| `host/native` | 7,320 | `agent-memory-fs/darwin-arm64` 3,560 and `darwin-x64` 3,800 |
| `Contents/Resources/app.asar` | 8 | empty shell |

Installers, rebuilt with `electron-builder --prepackaged` from the signed app: DMG 174,105,092 B (166 MiB), ZIP 169,154,771 B (161 MiB). The first unsigned build was DMG 175,215,035 B and ZIP 170,278,069 B.

The §6 risk estimate ("may exceed 300 MB unpacked") holds: 439 MiB on macOS arm64, with the second Node runtime being the largest part after Chromium. The darwin asset root ships both helper architectures (`sdkNativeAssetTargets.darwin`), so a per-arch app carries 3.7 MiB it never runs; that is SDK behavior and is out of D0's scope.

### Nested signing dry run (ad-hoc)

Without signing, the packaged app does not start: electron-builder skips signing with `identity: null`, but flipping the fuses already changed the binary, so the kernel kills it.

```
$ "BYOK Desktop Probe.app/Contents/MacOS/BYOK Desktop Probe"; echo exit=$?
exit=137
$ codesign --verify --deep --strict --verbose=2 "BYOK Desktop Probe.app"
BYOK Desktop Probe.app: code has no resources but signature indicates they must be present
```

So every build, even an unsigned CI build, must at least ad-hoc sign after the fuse flip (§3.1 "Credentials": "the build emits unsigned or ad-hoc-signed packages" must mean ad-hoc on macOS arm64).

The probe signed inside-out with the hardened runtime (`codesign --force --sign - --options runtime --timestamp=none`), 17 signatures, in this order:

1. Every Mach-O under `Resources/host` except the SEA: `native/agent-memory-fs/darwin-arm64`, `darwin-x64` (the x64 helper was unsigned before; `pi/` has no Mach-O today).
2. The SEA `Resources/host/host`, with entitlements.
3. Electron internals: `Libraries/libffmpeg.dylib`, `libvk_swiftshader.dylib`, `Helpers/app_shim_loader`, `Helpers/chrome_crashpad_handler`, `Squirrel.framework/.../ShipIt`.
4. The frameworks: Electron Framework, Mantle, ReactiveObjC, Squirrel.
5. The four helper apps, with entitlements.
6. The app bundle, with entitlements.

The probe's signing script:

```sh
#!/usr/bin/env bash
# D0 nested-sign dry run: inside-out, hardened runtime. IDENTITY='-' is ad-hoc; the owner sets a Developer ID.
set -euo pipefail
APP="$1"; IDENTITY="${IDENTITY:--}"; ENT="$(dirname "$0")/entitlements.plist"
TS=(--timestamp=none); [ "$IDENTITY" != "-" ] && TS=(--timestamp)
sign() { echo "sign: ${1#$APP/}"; codesign --force --sign "$IDENTITY" --options runtime "${TS[@]}" "${@:2}" "$1"; }
H="$APP/Contents/Resources/host"
# 1. Host leaves: memory helpers and any other Mach-O under resources/host (pi/ has none today)
while IFS= read -r f; do [ "$f" = "$H/host" ] || sign "$f"; done < <(find "$H" -type f -exec sh -c 'file -b "$1" | grep -q Mach-O && echo "$1"' _ {} \;)
# 2. The SEA Host (V8 needs JIT under the hardened runtime)
sign "$H/host" --entitlements "$ENT"
# 3. Electron framework internals, then frameworks, then helper apps
F="$APP/Contents/Frameworks"
for f in "$F/Electron Framework.framework/Versions/A/Libraries/"*.dylib "$F/Electron Framework.framework/Versions/A/Helpers/"* "$F/Squirrel.framework/Versions/A/Resources/ShipIt"; do sign "$f"; done
for fw in "$F/"*.framework; do sign "$fw"; done
for h in "$F/"*.app; do sign "$h" --entitlements "$ENT"; done
# 4. The app bundle last
sign "$APP" --entitlements "$ENT"
```

Entitlements used: `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`.

```
$ codesign --verify --deep --strict --verbose=2 "BYOK Desktop Probe.app"
--prepared:.../Frameworks/BYOK Desktop Probe Helper (GPU).app
--validated:.../Frameworks/BYOK Desktop Probe Helper (GPU).app
  ... (Plugin, Renderer, Helper, Electron Framework and its helpers, Mantle, ReactiveObjC, Squirrel)
BYOK Desktop Probe.app: valid on disk
BYOK Desktop Probe.app: satisfies its Designated Requirement
$ codesign -dv --entitlements - "BYOK Desktop Probe.app/Contents/Resources/host/host"
CodeDirectory v=20500 size=295374 flags=0x10002(adhoc,runtime) hashes=9219+7 location=embedded
	[Key] com.apple.security.cs.allow-jit
```

The same `--verify --deep --strict` passes for the app inside the mounted DMG and inside the unzipped ZIP (`ditto -x -k`).

**The SEA needs `allow-jit` under the hardened runtime** (§3.2 marked this as inferred). Measured on copies of the SEA:

```
$ codesign --force -s - --options runtime host-nojit && ./host-nojit ...
# Fatal process out of memory: Failed to reserve virtual memory for CodeRange
exit=133
$ codesign --force -s - --options runtime --entitlements jit-only.plist host-jitonly && ./host-jitonly -e 'console.log(1)'
BYOK_EMBEDDED_HOST {"ok":false,"error":"Error: unknown command \"-e\"..."}   # V8 started; the fixture rejected the argv
```

`allow-jit` alone is enough to start V8; whether the SEA also needs `allow-unsigned-executable-memory` or `disable-library-validation` under a Developer ID (team-ID library validation) is open until the owner's signed run.

Fuses read back from the packaged app:

```
RunAsNode is Disabled
EnableCookieEncryption is Enabled
EnableNodeOptionsEnvironmentVariable is Disabled
EnableNodeCliInspectArguments is Disabled
EnableEmbeddedAsarIntegrityValidation is Enabled
OnlyLoadAppFromAsar is Enabled
LoadBrowserProcessSpecificV8Snapshot is Disabled
GrantFileProtocolExtraPrivileges is Enabled
```

The Host child is unaffected by RunAsNode being off, because it is a separate Node SEA, not the Electron binary (§1.2 option C). A1 (#1816) also turns `GrantFileProtocolExtraPrivileges` off; the probe did not.

## Owner steps: Developer ID, notarize, staple (macOS)

Not attempted: they need the owner's identity. The owner provides, as environment variables only:

| Variable | What |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Developer ID Application certificate (`.p12`, base64 or path) and its password; or `CSC_NAME` naming an identity already in the login keychain |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key (`.p8` path), key id, issuer id for notarytool; or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

Commands, on a build of the A7 app (or the probe rebuilt from this note):

```sh
# 1. Sign inside-out with the Developer ID (same order as the dry run, secure timestamp on)
IDENTITY="Developer ID Application: <Name> (<TEAMID>)" ./sign-nested.sh "<App>.app"
codesign --verify --deep --strict --verbose=2 "<App>.app"
# 2. Notarize the DMG, then staple the app and the DMG
xcrun notarytool submit "<App>.dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "<App>.dmg"
xcrun stapler validate "<App>.dmg"
# 3. Gatekeeper assessment of the installed app
spctl -a -vv "/Applications/<App>.app"
spctl -a -vv -t open --context context:primary-signature "<App>.dmg"
# 4. Launch smoke: the BYOK_PROBE_REPORT run above must still report ok/refused, with no Keychain prompt in the probe (auth_mode none)
```

With electron-builder signing instead of the script, set `mac.hardenedRuntime: true`, `mac.entitlements` and **`mac.entitlementsInherit` to a file with `allow-jit`**, because the SEA under `Resources/host` gets the inherited entitlements, and remove `mac.identity: null`. Keychain prompts per binary (§6 "Keychain prompts") can only be measured on this signed build.

## Windows x64

Measured on this machine, without win-ci, from the pinned archive:

```
$ curl -o koffi.tgz https://registry.npmjs.org/@koromix/koffi-win32-x64/-/koffi-win32-x64-3.3.7.tgz
$ node -e 'copySdkNativeAssets({ outDir, platform: "win32", arch: "x64", archivePath: "koffi.tgz" })'
$ shasum -a 256 native/win32-x64/koffi.node
38c7361513d2d26716b5da8d4e0b78bfe6500f51e0e87f7fefacc362f1e198cf   # equals KOFFI.sha256 (sdk-native-assets-pin.ts)
```

- Asset root without the SEA: 33,896 KiB (`pi/` 28,968; `native/` 4,928, of which `koffi.node` 1,078,784 B and `agent-memory-fs/win32-x64.exe` 3,939,840 B).
- Neither `koffi.node` nor `win32-x64.exe` carries an Authenticode signature (PE security directory size 0), so any signing pass that touches `koffi.node` changes its bytes and the SDK refuses it (`unmodified-official-addon`).
- electron-builder 26.18.0 `WinPackager.shouldSignFile` signs a file only when it ends in `.exe` unless `win.signExts` lists more. With the default, the SEA `host.exe` and the memory helper are signed and `koffi.node` is not. A7 should still set `win.signExts: ['!.node']` so a later `signExts` addition cannot reach it.

Open, waiting for a win-ci slot from t3 (win-ci was unreachable through hc during this probe). Prepared steps, run with `hc exec --on win-ci` only, in a temp directory deleted at the end, nothing installed into the owner's profile, stopping on any prompt or connection failure:

1. `$d = Join-Path $env:TEMP "byok-d0-$(Get-Random)"`; check out this branch there; `bun ci`, `bun run build`, `bun run --filter @byok-sdk/client build:agent-memory-helper`.
2. Baseline: `node examples/packaging/embedded-host-smoke.mjs --format sea`.
3. Build the probe Host SEA and `host-ship\` as above (`platform: 'win32', arch: 'x64'`), the shell with `win.target: nsis` (per-user), `win.signExts: ['!.node']`, unsigned.
4. Record sizes: `win-unpacked\` total, `resources\host\`, the NSIS installer.
5. Run `win-unpacked\<App>.exe` with `BYOK_PROBE_REPORT` and check `ok`, `refused`, `agentMemoryMcp: 'admitted'`.
6. Signing without the certificate store: a throwaway self-signed code-signing `.pfx` made with Git Bash `openssl` inside `$d`, passed as `CSC_LINK`/`CSC_KEY_PASSWORD` (signtool `/f`, no import), rebuild, then `Get-FileHash -Algorithm SHA256 win-unpacked\resources\host\native\win32-x64\koffi.node` must equal `38c73615...98cf`, and step 5 must pass again.
7. `Remove-Item -Recurse -Force $d`.

## Linux x64

No Linux machine. Per t4's ruling the check runs on a GitHub Actions runner: three steps appended to the `desktop` lane of `.github/workflows/ci.yml` (selected by `examples/desktop-bot-app/` changes):

1. Start a D-Bus session and an unlocked `gnome-keyring` Secret Service (`xvfb`, `dbus-x11`, `libsecret-tools`).
2. Round-trip a secret through `LinuxSecretServiceSecretStore` from `packages/keys/dist`, then point `DBUS_SESSION_BUS_ADDRESS` at a missing bus: `available()` must be false and `set` must reject (no plaintext fallback). This step asserts.
3. Report only: OS release, `kernel.apparmor_restrict_unprivileged_userns`, `chrome-sandbox` mode, and whether Electron from `node_modules` reaches `ready` under `xvfb-run` with and without `--no-sandbox`. Written to the job summary.

Local pre-check of steps 1-2 in a container (`node:24.22.1`, Debian bookworm userland, on Colima's Ubuntu 24.04.4 VM, kernel 6.8.0-117, aarch64):

```
Package: libsecret-tools  Version: 0.20.5-3
Package: gnome-keyring    Version: 42.1-1+b2
D0 libsecret: round trip ok, no-bus fails closed
apparmor_restrict_unprivileged_userns=1
```

Limits: the container proves the store logic against a real Secret Service, but not on Ubuntu's libsecret build or on x64; the runner result in the `desktop` lane replaces it. The `=1` read is the Colima VM's Ubuntu 24.04 kernel, which shows the restriction is on by default there, not what an end user's desktop session or AppArmor profile allows. Neither the container nor the runner installs the packaged app: whether a deb-installed (setuid `chrome-sandbox`) or AppImage build starts under Ubuntu 24.04's restriction without a custom AppArmor profile is open until A7 (#1811) builds the Linux packages.

## What is proven, what is open

Proven (macOS arm64, this machine):

- The `examples/packaging` SEA Host runs from `resources/host/` of a packaged Electron app: Pi foreground on both the keys-launcher and Pi-auth-store lanes, the memory helper, and the R2 refusal.
- An inside-out, hardened-runtime ad-hoc signing of the app, the SEA and the memory helpers passes `codesign --verify --deep --strict`, also inside the DMG and the ZIP, and the signed app still runs the Host.
- The SEA needs `allow-jit`.
- Unsigned-after-fuses apps do not start on arm64.
- `koffi.node` copied from the pinned archive equals the pin, and electron-builder's default Windows signing does not touch `.node` files.
- The Linux keys store works against a real Secret Service and fails closed without a bus (container).

Open:

- Developer ID signing, notarization, stapling and `spctl` (owner steps above), and whether the SEA needs more than `allow-jit` with a team ID.
- Keychain prompts per signed binary.
- Windows: sizes, the packaged run and the post-signing `koffi.node` hash (win-ci slot).
- Linux: the runner result (first `desktop` lane run of this PR) and the packaged-app AppArmor answer (A7).
- macOS x64 (not built).
