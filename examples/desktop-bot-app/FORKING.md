# Forking the desktop Bot app

This app is a template for a SaaS team's own desktop client. It has an Electron shell, a supervised Host child, and K8 Bots on the device. This guide covers five things: what to copy, what to rebrand, where your SaaS takes over the roster and history, how to follow SDK upgrades, and how to ship updates. [README.md](README.md) describes the architecture, and #1499 records the design.

## 1. Copy

Copy the whole `examples/desktop-bot-app/` directory into your repository at the SDK release tag you build on. Copy it as one unit: the bridge, main, preload, renderer and Host are written against each other, and `BRIDGE_VERSION` must match exactly between the shell and the Host it ships.

Then replace the workspace dependencies:

| In this repository | In your fork |
| --- | --- |
| `@byok-sdk/client`, `@byok-sdk/server`, `@byok-sdk/keys`, `@byok-sdk/ui-runtime`, `@byok-sdk/bot-collaboration`: `workspace:*` | The npm packages at the version of the tag you copied. The SDK packages are released together under one version, K8 (`@byok-sdk/bot-collaboration`) included, so pin all of them to exactly that version. |

K8 is a dependency, not code you copy: you take its fixes by bumping the version with the rest of the SDK. `@byok-sdk/bot-collaboration` reaches npm with the first release the repository owner publishes after #1845. Until then no version of it exists on npm to pin. The app imports K8 through its entries only:

- `@byok-sdk/bot-collaboration`: `BotCollaboration`, `teamSnapshot` and `TeamModeError`, `createBotPersonaProjection`, `botCompactVeto`, and the message types.
- `./host-kit`: Host adapter types and `historyRowFromTurn`, `RetentionRefused`.
- `./testing`: tests only. The synthetic `ResultStubAdapter` and the in-memory `InMemoryDeviceCredentials`.
- `./rules`: the app does not import it.

Import only from these entries: a deep import into the package's files is not part of its contract.

What you do not need: `scripts/ci/*` and `.github/workflows/ci.yml` are this repository's gates. Take the `desktop` job of `ci.yml` as the model for your own pipeline, because the package smoke there is the only check that runs the packaged Host on all three platforms.

## 2. Rebrand

| Where | What | Rule |
| --- | --- | --- |
| `brand.config.ts` `productName` | Window title, OS application name, tray tooltip | Free to change. |
| `brand.config.ts` `productId` | The SDK product id. It names the local stores (`resolveHostLayout`), the OS credential entries and the Linux executable. | Choose it once. A changed id is a new product with empty stores: no migration reads the old ones. |
| `brand.config.ts` `externalOrigins` | The https origins a link may open in the system browser | Everything else stays refused. |
| `brand.config.ts` `instruction`, `roles` | The base instruction of every Turn, and the "New by role" presets | Free to change. |
| `brand.config.ts` `models` | The model catalog. The first entry is the default for new Bots. | A Bot stores only the entry id, so never rename or remove an id that Bots use: their Turns stay blocked until they are re-pointed. Do not start an id with `pi:`. The Host adds one `pi:<profile_ref>` entry per keys profile, and a collision refuses the catalog. |
| `assets/tray/` | Tray icons: `trayTemplate.png` and `@2x` (macOS template images, black with alpha), `tray.png` elsewhere | Keep the file names, or change `TRAY_ICON` in `src/main/index.ts`. |
| `electron-builder.config.mjs` | `appId` (`io.byok-sdk.<productId>`), `extraMetadata.homepage`, Linux `category` and `maintainer` | Set your own reverse-DNS `appId` before the first release: it is the macOS bundle id and the Windows app user model id, which installed updates must keep. |

The renderer reads only the theme tokens in `src/renderer/theme/tokens.css`, so restyling is that one file.

## 3. Your SaaS as the roster and history authority

K8 runs in `team: 'external'` mode with an external history. In this app, the authority for both is the local Host store (`src/host/store/store.ts`, SQLite under `<hostStorageRoot>/host/`). `src/host/k8/conversation.ts` is the only code that talks to both sides.

The seam is synchronous today. `HostStore` runs on `node:sqlite` `DatabaseSync`, and `Conversation` calls every store method without `await`: `recordInput` and `bindInput`, `recordClear` inside the synchronous `clear()`, `saveBot` with its `admit` check running inside the store transaction, `roster`, `raiseRevision`, `history`, `retainableRoots` and `markRetained`. A Promise-returning replacement would typecheck, and its rejections would go unhandled, which breaks store-first and fail-closed. So a remote authority changes `Conversation` too:

- Every store call is awaited, and `clear()` becomes async, along with `ConversationService.clear` behind `k8.clear`.
- `saveBot`'s `admit` check (K8's `teamSnapshot` and the catalog check) runs on the candidate roster before the authority commits it, because the commit is no longer a local transaction that the check can abort.
- The keyed-command semantics below move into your API: the same action id returns the first result, other arguments conflict.

The invariants `Conversation` relies on:

- **Store first, then K8.** Every user command is written to the authority before K8 sees it, keyed by the renderer's action id. A retry with the same id returns the first result, and the same id with other arguments is a conflict (`StoreConflictError`). At the next open, `unboundInputs()` and K8 `inputRoot` finish a send that the authority holds but K8 may not.
- **Roster revision.** `roster()` returns the Bots with a revision that only grows. On K8 `stale_team`, `raiseRevision(above)` moves the authority above K8's revision, and the roster is sent again. A candidate roster passes K8's own snapshot check (`teamSnapshot`) before the authority commits it.
- **History.** `history(botId, turnId)` returns the Bot's ended Turns after its clear epoch, each with the reply the user saw. `recordClear` writes only an epoch marker and deletes nothing.
- **Reply visibility (R1).** `Conversation` hands `recordTurn` a reply only after the Turn's intent concluded `succeeded` with that reply's task id, and after the body read back through `tasks.agentMessage` matches its `contentHash`. See ["Reply visibility"](../../packages/bot-collaboration/README.md#reply-visibility) in K8's README. Your API must not show a reply from any earlier point.
- **Retention.** `retainableRoots()` lists the roots whose Turns all ended in the authority; only those are offered to K8 `retain`, and `markRetained(root)` records it.

When the authority cannot be reached, the command fails and the UI shows the error. Do not keep a local copy as a second authority. K8's README sections "External team authority" and "External history authority" ([`packages/bot-collaboration/README.md`](../../packages/bot-collaboration/README.md)) define the K8 side of this contract.

## 4. Following SDK upgrades

Each SDK release has a Host upgrade guide in `docs/releases/host-upgrade-<version>.md`. Upgrade one release at a time and work through its guide as a checklist:

1. Bump every `@byok-sdk/*` dependency to the same exact version, `@byok-sdk/bot-collaboration` included.
2. For each section of the guide, decide whether it touches this app. Sections that always touch it: store compatibility (the Host prechecks `inspectDaemonStores`, `inspectSqliteStore` and `inspectProviderProfileStore` at start and migrates a keys store only on `migration-required`), Pi and packaging (`resolveSdkHosting`, the SEA helper re-entry), runtime environment policy, and anything under "Bot collaboration". Record your decision for each section in your upgrade PR.
3. Re-check reply visibility against K8's README if the guide changes K8 or `tasks.agentMessage`.
4. If you change the bridge, raise `BRIDGE_VERSION` in `src/bridge/protocol.ts`. A shell and a Host of different versions refuse each other on purpose.
5. Run the app's typecheck and tests, then the package smoke on macOS, Windows and Linux before you release.

A refused store stops the Host with its reason. The app never repairs a store on its own, so an upgrade that changes a store contract needs its migration step in that release.

## 5. Shipping updates

The template ships the update client (`electron-updater`, `src/main/updater.ts`) and no update server.

- **Feed.** Set `BYOK_UPDATE_FEED_URL` when you package (`bun run package`). electron-builder then writes `app-update.yml` into the app. Without it the build has no updater. Upload the contents of `dist/package/out` to that URL on any static HTTPS host: the installers, their `.blockmap` files and the `latest*.yml` files. Upload the `latest*.yml` files last, because a client reads them to find the installer.
- **Install.** The app checks the feed at start. When an update is downloaded, it asks the user, stops the Host, copies the current stores to `<storeDir parent>/<productId>.update-snapshots/<version>/`, and only then installs. If the snapshot fails, nothing installs and the app restarts on the current version.
- **Rollback.** Install the previous version and restore its snapshot by hand. The snapshot is the only rollback; there is no automatic downgrade.
- **Signing.** Signing reads the environment only, as listed in `electron-builder.config.mjs`: macOS `CSC_LINK`/`CSC_KEY_PASSWORD` or `CSC_NAME`, with notarization through `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`; Windows `CSC_LINK`/`CSC_KEY_PASSWORD`. Unset, macOS signs ad hoc and Windows stays unsigned, which is enough for CI but not for users. macOS updates install only on a signed build. Keep `koffi.node` out of every signing pass (`signExts: ['!.node']`), because the SDK refuses a modified addon.

## Known limits

- The packaged Host is a Node SEA, so Pi cannot run background subagents or workflows. Such a request fails the Turn with `pi_background_unavailable`, and foreground subagents work (#1499 R2).
- Linux has no login item (`settings.loginItem` reports `supported: false`).
- The roster, history and Host run on the user's device. A remote Host variant is outside this template.
