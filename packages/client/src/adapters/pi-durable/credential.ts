/** The launcher owns this private JSON IPC endpoint; the daemon only sees stdio RPC. */
export async function receiveDurableCredential(configDigest: string): Promise<string | undefined> {
  if (!process.connected || !process.send) throw new Error('durable custody IPC unavailable');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, secret?: string) => {
      if (settled) return; settled = true;
      process.off('message', message); process.off('disconnect', disconnected);
      // Close before constructing ExecutionEnv/MCP or admitting model work.
      const complete = () => { if (error) reject(error); else resolve(secret); };
      if (process.connected) { process.once('disconnect', complete); process.disconnect(); }
      else complete();
    };
    const disconnected = () => finish(new Error('durable custody IPC closed before credential'));
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { finish(new Error('invalid durable custody receipt')); return; }
      const frame = value as Record<string, unknown>;
      if (Object.keys(frame).length !== 3 || frame.type !== 'byok.pi.durable.credential' || frame.configDigest !== configDigest
        || (frame.secret !== null && (typeof frame.secret !== 'string' || !frame.secret))) { finish(new Error('invalid durable custody receipt')); return; }
      finish(undefined, frame.secret === null ? undefined : frame.secret as string);
    };
    process.once('message', message); process.once('disconnect', disconnected);
    process.send!({ type: 'byok.pi.durable.credential-request', configDigest }, error => { if (error) finish(new Error('durable custody IPC send failed')); });
  });
}
