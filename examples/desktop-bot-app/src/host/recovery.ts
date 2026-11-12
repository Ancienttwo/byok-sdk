/**
 * Start fresh (#1499 D4, #1917), run by the Host executable re-entered under
 * {@link START_FRESH_COMMAND} after main stopped the Host. It runs here, not in
 * main, because clearing the device enrollment needs the Host's SDK assets (the
 * koffi addon on Windows).
 */
import { clearDeviceEnrollment, DeviceEnrollmentClearError, type DeviceCredentialBackend } from '@byok-sdk/client';
import { START_FRESH_COMMAND, type StartFreshReceipt } from '../recovery/protocol.ts';
import { moveAll, moveBack, MoveBackError, startFreshMoves, type Move, type StoreLayout } from '../recovery/stores.ts';

export interface StartFreshOptions {
  readonly layout: StoreLayout;
  readonly productId: string;
  readonly stamp: string;
  /** `DaemonConfig.nativeAssetRoot` of a packaged Windows Host. */
  readonly nativeAssetRoot?: string;
  /** Tests inject the device credential backend, as the daemon takes one. */
  readonly deviceCredentials?: DeviceCredentialBackend;
}

/**
 * Moves the SDK store, the Host stores with their snapshots, and the Agent homes
 * aside, then clears the device enrollment of the moved SDK store, so the next
 * Host pairs a new device. The moves come first because they can be undone and
 * the clear cannot: a failed move, or a clear the SDK refuses, moves everything
 * back. The SDK binds an enrollment to the content of `device.json`, not to the
 * directory, so the moved store clears as the original would. Nothing is deleted
 * but the enrollment: its `device.json` and its OS credential.
 */
export async function startFresh(options: StartFreshOptions): Promise<readonly Move[]> {
  const done = await moveAll(startFreshMoves(options.layout, options.stamp));
  const store = done.find(move => move.from === options.layout.storeDir);
  if (store === undefined) return done;
  try {
    await clearDeviceEnrollment(
      { productId: options.productId, storeDir: store.to, ...(options.nativeAssetRoot === undefined ? {} : { nativeAssetRoot: options.nativeAssetRoot }) },
      options.deviceCredentials === undefined ? undefined : { deviceCredentials: options.deviceCredentials },
    );
  } catch (error) {
    await moveBack(done, error);
  }
  return done;
}

/** The re-entered command: one receipt line on stdout; exit 0 only when the stores moved and the enrollment cleared. */
export async function runStartFreshCommand(args: readonly string[], options: Omit<StartFreshOptions, 'stamp'>): Promise<number> {
  // The stamp names the aside directories, so it must stay one plain path segment.
  if (args.length !== 2 || !/^[0-9TZ.-]+$/.test(args[1]!)) throw new Error(`${START_FRESH_COMMAND} takes one argument: the aside stamp`);
  let receipt: StartFreshReceipt;
  try {
    receipt = { ok: true, moved: await startFresh({ ...options, stamp: args[1]! }) };
  } catch (error) {
    const failure = error instanceof MoveBackError ? error.cause : error;
    receipt = { ok: false, code: failure instanceof DeviceEnrollmentClearError ? failure.code : 'start_fresh_failed',
      message: (error as Error).message, movedBack: !(error instanceof MoveBackError) };
  }
  await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(receipt)}\n`, error => (error ? reject(error) : resolve())));
  return receipt.ok ? 0 : 1;
}
