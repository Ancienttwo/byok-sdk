// DIAG #1317 -- do not merge. E1g: rewrites readWindowsRegistryKey in a
// checkout of the #1400 head so every read appends one JSON line to <log>:
// which step threw (system-root, secure-dir, execFile, readFile, parse, rm),
// the error's name, code, killed and signal, the icacls exit class, and the
// elapsed ms. No file content, path or variable value is written. With
// E1H_ISOLATE=1 each reg.exe gets its own TEMP/TMP (E1h).
// Usage: node e1g-instrument.mjs <impl checkout> <absolute log path>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [root, log] = process.argv.slice(2);
if (!root || !log || !path.isAbsolute(log)) throw new Error('usage: e1g-instrument.mjs <impl checkout> <absolute log path>');
const file = path.join(root, 'packages', 'client', 'src', 'runtime', 'environment.ts');
const source = readFileSync(file, 'utf8');
const start = source.indexOf('export async function readWindowsRegistryKey(');
const end = source.indexOf('\nconst REGISTRY_ROOTS');
if (start < 0 || end < 0) throw new Error('readWindowsRegistryKey not found');
const body = `export async function readWindowsRegistryKey(key: string): Promise<ReadonlyMap<string, WindowsRegistryString>> {
  const started = Date.now();
  const note = (step: string, error?: unknown): void => {
    const e = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | undefined;
    const icacls = e instanceof Error ? /icacls exited -?\\d+|could not run icacls/u.exec(e.message)?.[0] ?? null : null;
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({
      key: key.startsWith('HKLM') ? 'machine' : 'user', step, ok: error === undefined,
      name: e?.name ?? null, code: e?.code ?? null, killed: e?.killed ?? null, signal: e?.signal ?? null, icacls, ms: Date.now() - started,
    }) + '\\n');
  };
  let failed = false;
  const step = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    try { return await run(); } catch (error) { failed = true; note(name, error); throw error; }
  };
  const reg = await step('system-root', () => {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot) || /[\\u0000\\r\\n]/u.test(systemRoot)) throw new Error('SystemRoot is not an absolute path');
    return path.win32.join(systemRoot, 'System32', 'reg.exe');
  });
  const directory = await step('secure-dir', async () => {
    const { createPrivateSystemTempDir } = await import('../util/secure-dir');
    return createPrivateSystemTempDir('byok-reg-');
  });
  try {
    const file = path.join(directory, 'key.reg');
    await step('execFile', () => new Promise<void>((resolve, reject) => {
      // E1h: E1H_ISOLATE=1 points this reg.exe's TEMP and TMP at its own private directory.
      const env = process.env.E1H_ISOLATE === '1' ? { ...process.env, TEMP: directory, TMP: directory } : undefined;
      execFile(reg, ['export', key, file, '/y'], { timeout: REG_EXPORT_TIMEOUT_MS, windowsHide: true, ...(env === undefined ? {} : { env }) }, (error) => error ? reject(error) : resolve());
    }));
    const bytes = await step('readFile', () => fs.readFile(file));
    const values = await step('parse', () => parseWindowsRegistryExport(bytes, key));
    return values;
  } finally {
    await step('rm', () => fs.rm(directory, { recursive: true, force: true }));
    if (!failed) note('done');
  }
}
`;
const instrumented = `import { appendFileSync } from 'node:fs';\n${source.slice(0, start)}${body}${source.slice(end)}`;
writeFileSync(file, instrumented);
console.log(`instrumented ${path.relative(root, file)} -> ${log}`);
