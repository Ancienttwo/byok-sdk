export type {
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeDetectResult,
  Session,
  TaskContext,
} from './types';
export { PolicyUnsupportedError } from './types';

export { createDaemon, createDaemonWithAdapters } from './daemon/create-daemon';
export type { Daemon, DaemonConfig, DaemonStatus, DaemonOverrides, DaemonBranding } from './daemon/create-daemon';
export type { DeviceRecord } from './daemon/store';
export { AuthManager, DeviceRevokedError } from './daemon/auth-manager';
export type { ConnectionState } from './daemon/ws-transport';
export { BlobClient } from './daemon/blob-client';
export type { BlobResolver } from './daemon/blob-client';
// M3-2a: local observability — the seam the CLI (M3-2b) consumes for a live
// task feed, a task list, and approve/reject/unpair, all local to a running
// daemon. See `daemon/observer.ts`.
export { DaemonObserver } from './daemon/observer';
export type { DaemonEvent, DaemonEventKind, DaemonEventListener, DaemonTaskInfo, Unsubscribe } from './daemon/observer';

// M3-4: OS service lifecycle (launchd/systemd/WinSW) — see `lifecycle/create-service-lifecycle.ts`.
export { createServiceLifecycle, UnsupportedServicePlatformError } from './lifecycle/create-service-lifecycle';
export type { CreateServiceLifecycleOptions } from './lifecycle/create-service-lifecycle';
export { nodeAgentProgram, sanitizeServiceName } from './lifecycle/service-types';
export type {
  NodeAgentProgramOptions,
  ServiceDefinition,
  ServiceInstallOptions,
  ServiceLifecycle,
  ServiceProgram,
  ServiceStatusResult,
} from './lifecycle/service-types';
export { generateLaunchdPlist } from './lifecycle/launchd';
export { generateSystemdUnit } from './lifecycle/systemd';
export { generateWinswXml } from './lifecycle/winsw';

// Finding F7: the storeDir-hardening chokepoint (`DeviceStore.save()`/
// `control-server.ts`'s `startControlServer` both funnel through this) —
// exported as a building block for a product's own deployment smoke checks
// (see `templates/service/winsw/smoke-test.mjs`'s own win32-only use of it),
// mirroring `generateWinswXml`/`nodeAgentProgram` above. Finding R4:
// `SecureDirHardeningError` is also exported — win32 pairing (`daemon.pair()`)
// can now reject with this typed error if `icacls` fails, and a product
// wrapping this SDK may want to catch it specifically (e.g. to render a
// dedicated "couldn't secure the credential directory" message).
export { ensureSecureDir, buildIcaclsArgs, SecureDirHardeningError } from './util/secure-dir';
export type { EnsureSecureDirOptions } from './util/secure-dir';

export { PiAdapter } from './adapters/pi/pi-adapter';
export type { PiAdapterOptions } from './adapters/pi/pi-adapter';
export { PI_PACKAGE_NAME } from './adapters/pi/resolve-bin';

export { ClaudeAdapter } from './adapters/claude/claude-adapter';
export type { ClaudeAdapterOptions } from './adapters/claude/claude-adapter';

export { CodexAdapter, type CodexAdapterOptions } from './adapters/codex/codex-adapter';
