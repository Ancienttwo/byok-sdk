/**
 * The marker the keys projection carries for an rpc provider whose key the
 * launcher delivers over IPC. Restated rather than imported: `@byok-sdk/client`
 * has no `@byok-sdk/keys` dependency. `pi-rpc-key-custody.test.ts` pins it.
 */
export const PI_RPC_IPC_KEY_MARKER = 'byok:rpc-ipc';

/**
 * The launcher owns this private JSON IPC endpoint; the daemon only sees stdio RPC.
 *
 * The rpc host and the durable worker both run model-callable tools that
 * inherit their process environment, so the keys launcher hands them the
 * provider key here instead. The frame types carry the lane, so a frame meant
 * for one entry is never accepted by the other. The keys launcher states the
 * same names (`startPiProvider`); `@byok-sdk/client` has no `keys` dependency.
 */
export async function receiveLauncherCredential(lane: 'rpc' | 'durable', configDigest: string): Promise<string | undefined> {
  if (!process.connected || !process.send) throw new Error(`${lane} custody IPC unavailable`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, secret?: string) => {
      if (settled) return; settled = true;
      process.off('message', message); process.off('disconnect', disconnected);
      // Close before constructing tools/MCP or admitting model work.
      const complete = () => { if (error) reject(error); else resolve(secret); };
      if (process.connected) { process.once('disconnect', complete); process.disconnect(); }
      else complete();
    };
    const disconnected = () => finish(new Error(`${lane} custody IPC closed before credential`));
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { finish(new Error(`invalid ${lane} custody receipt`)); return; }
      const frame = value as Record<string, unknown>;
      if (Object.keys(frame).length !== 3 || frame.type !== `byok.pi.${lane}.credential` || frame.configDigest !== configDigest
        || (frame.secret !== null && (typeof frame.secret !== 'string' || !frame.secret))) { finish(new Error(`invalid ${lane} custody receipt`)); return; }
      finish(undefined, frame.secret === null ? undefined : frame.secret as string);
    };
    process.once('message', message); process.once('disconnect', disconnected);
    process.send!({ type: `byok.pi.${lane}.credential-request`, configDigest }, error => { if (error) finish(new Error(`${lane} custody IPC send failed`)); });
  });
}
