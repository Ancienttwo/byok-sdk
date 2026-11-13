/**
 * The bound, in ms, on each kind of platform command (#1971). A command past
 * its bound is stopped and fails; whether it took effect is then unknown.
 * `winsw` covers WinSW's `start`/`stop`/`stopwait`, which wait on the SCM
 * (and `stop` on the service's own `stoptimeout`); `platform` covers every
 * `launchctl`, `systemctl`, `sc.exe`, PowerShell and `icacls` run.
 */
export const COMMAND_TIMEOUT_MS = { platform: 30_000, winsw: 120_000, hostStop: 60_000, launch: 30_000 } as const;
