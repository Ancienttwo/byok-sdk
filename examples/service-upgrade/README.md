# Service upgrade example

An App that ships the `byok-agent` single-file bundle as its background service
and installs, upgrades, rolls back and uninstalls it through the SDK (#1097).
`app-installer.ts` is the App's installer half; `byok-agent install --payload`
and `byok-agent upgrade` call the same `createServiceInstallation`, so the App
and the CLI differ only in the lifecycle owner they record (`app`, `cli`).

The App keeps what stays with a Host: where payloads are downloaded from, the
release channel, the signature check and the update UI. It hands the SDK a
verified payload directory and reads `upgrade-receipt.json` (or the thrown
`ServiceInstallationError`) to tell its user what happened. See
[device setup](../../docs/device-setup.md#versioned-installs) for the payload
format and the upgrade steps.

```sh
node app-installer.ts install --payload ./payload-1 --install-root ./app --config device.json
node app-installer.ts upgrade --payload ./payload-2 --install-root ./app --config device.json
node app-installer.ts rollback --install-root ./app --config device.json
node app-installer.ts uninstall --install-root ./app --config device.json
```

On Windows pass `--winsw-bin <WinSW-x64.exe>` (and `--winsw-install-dir` for a
short install path).

## A service with several daemon stores

A service process that runs more than one daemon, for example one per signed-in
identity, lists them in `daemonStores()` (#1328). The installation calls it after
every stop, on upgrade, rollback and recover, and gives the service no store
access until each listed store has no live owner:

```ts
createServiceInstallation({
  service, productId, installRoot, program, precheck,
  healthCheck,                               // required with daemonStores
  daemonStores: async () => [
    { storeDir: service.storeDir, productId },
    ...(await signedInIdentities()).map((id) => ({ storeDir: identityStoreDir(id), productId: researchProductId })),
  ],
});
```

Each `storeDir` is absolute and listed once, and each `productId` is not
empty; an empty list is valid. A list that breaks this, or a `daemonStores()`
that throws, fails the upgrade with `daemon_stores_invalid` before anything is
switched, and the old version is started again. Every store is held with an
owner lease until the pointer switch ends: a store whose owner is still alive
when `stopTimeoutMs` (one deadline for all stores) runs out is `store_busy`,
and what a crashed daemon left (its owner file and a `control.token` nobody
answers on) is reclaimed instead.

## Pairing a Windows service

WinSW runs the service as `LocalSystem`, and Windows Credential Manager entries
belong to the process token that wrote them. An enrollment that `byok-agent pair`
wrote as the interactive user is invisible to the service. The config therefore
sets `serviceEnrollment: { enabled: true }`: install the unpaired service first,
then `byok-agent pair` hands the code to the running service over its local
control endpoint, and the service stores the enrollment under its own account.
Every later version, started by the same service, reads it there. On macOS and
Linux the service runs as the user, and the same flow stores the enrollment in
the user's keychain or Secret Service.

## Tests and smoke

- `bun run test` runs the installer against the built SDK on the paths that
  end before the service manager is asked anything: no installation, a payload
  whose bytes do not match its manifest, a file the manifest does not list.
- `node upgrade-smoke.mjs` (from the repository root:
  `node examples/service-upgrade/upgrade-smoke.mjs`, after `bun run build`; set
  `WINSW_BIN` on Windows) runs a real service under launchd, systemd `--user` or
  WinSW twice, once through the CLI and once through this installer. Each run
  installs v1, pairs through the service, upgrades to v2, has v3 fail its health
  check and restores v2 with its store snapshot, rolls back to v1, and
  uninstalls. On Windows it also kills the daemon with `taskkill /F` and waits
  for the SCM to restart it, and keeps the stores on an 8.3 short-name path and
  on a path longer than 260 characters (#1030).
