import { servesHermesHome, type HermesGatewayIdentity } from './gateway-identity';

/**
 * Whether the gateway that answers with `pid` runs in the process tree the
 * adapter started at `root`. On POSIX the adapter starts Hermes itself, or the
 * custody launcher replaces itself with Hermes, so the gateway pid is `root`.
 * On Windows a console-script `hermes.exe` and the custody launcher start
 * Hermes's Python as a child, so the gateway is below `root`. Rejects when the
 * Windows process table cannot be read, or when `signal` aborts the read.
 */
export async function ownsHermesGatewayPid(root: number, pid: number, signal?: AbortSignal): Promise<boolean> {
  if (pid === root) return true;
  if (process.platform !== 'win32') return false;
  // The Windows walk lives in the lazy session entry, so the root entries do not carry it.
  const { descendsOnWindows } = await import('#byok-hermes-session');
  return descendsOnWindows(root, pid, signal);
}

/**
 * Whether the adapter may stop a gateway it does not own that answered after
 * the viewer attached. On POSIX only this execution can reach the profile
 * directory that holds the control socket, so a gateway that serves the
 * profile (`served`, a real path) was started for it. On Windows the pipe
 * name is in one machine-wide namespace: the gateway must run below the
 * viewer the adapter started. There `identity.pid` is the server pid from the
 * kernel, because a server the adapter does not own receives no request.
 * A process-table read that fails or outlives `signal` means "do not stop".
 */
export async function mayStopForeignHermesGateway(identity: HermesGatewayIdentity, served: string, viewer: number | undefined, signal?: AbortSignal): Promise<boolean> {
  if (process.platform !== 'win32') return servesHermesHome(identity, served);
  if (viewer === undefined) return false;
  return ownsHermesGatewayPid(viewer, identity.pid, signal).catch(() => false);
}
