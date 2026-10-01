import { appendFileSync, writeFileSync } from 'node:fs';
import { sealRuntimeOperationManifest } from '../src/types.ts';

export function logger(file) {
  writeFileSync(file, '', { mode: 0o600 });
  return value => appendFileSync(file, JSON.stringify({ time: Date.now(), ...value }) + '\n');
}
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export async function bounded(promise, label, ms = 90000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function startAdapter(adapter, instruction, cwd, env, taskId) {
  const policy = { mode: 'auto' };
  const prepared = await adapter.prepare({ offer: { instruction, policy }, policy, descriptor: adapter.descriptor, requiredToolsetIds: [] });
  if (prepared.kind === 'reject') throw new Error(prepared.reason);
  const manifest = sealRuntimeOperationManifest({ taskId, runtimeId: adapter.descriptor.id, descriptor: adapter.descriptor,
    policy, requiredToolsetIds: [], workspace: { workspaceDir: cwd }, forwardedEnvironmentNames: Object.keys(env).sort() });
  return prepared.operation.start({ kind: 'instruction', instruction, env, manifest, mcpEnv: {} });
}
export async function collect(session, emit) {
  const events = [];
  try {
    for await (const event of session.events) { events.push(event); emit({ kind: 'adapter.event', event }); if (event.type === 'turn_end') break; }
    return { events };
  } catch (error) { return { events, error: String(error) }; }
}
// Observe the same bytes without changing stdin/stdout or the SDK control path.
export function tapChild(child, receive, written) {
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8'); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { receive(JSON.parse(line)); } catch { /* Ignore non-JSON diagnostic lines. */ }
    }
  });
  if (written) {
    const original = child.stdin.write;
    child.stdin.write = function(chunk, ...args) {
      try { for (const line of String(chunk).trim().split('\n')) written(JSON.parse(line)); } catch {}
      return original.call(this, chunk, ...args);
    };
  }
}
