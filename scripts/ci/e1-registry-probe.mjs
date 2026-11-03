// #1317 E1 probe (temporary, removed before freeze): can `reg query` and
// `reg export` read a non-ASCII REG_EXPAND_SZ / REG_SZ value back verbatim?
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const reg = path.win32.join(process.env.SystemRoot, 'System32', 'reg.exe');
const key = `HKCU\\Software\\byok-e1-${process.pid}`;
const expand = 'C:\\Users\\runner\\byok 空間 é\\bin;%USERPROFILE%\\x;%BYOK_E1_UNDEFINED%';
const plain = 'C:\\工具\\ü;.JS';
const run = (args) => new Promise((resolve) => execFile(reg, args, { encoding: 'buffer', windowsHide: true }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
const show = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);

console.log(execFileSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'utf8' }).trim());
// PowerShell writes the values with the .NET registry API, so the setup itself is not a reg.exe encoding question.
execFileSync('powershell.exe', ['-NoProfile', '-Command', `
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\byok-e1-${process.pid}')
  $k.SetValue('Path', '${expand}', [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $k.SetValue('PATHEXT', '${plain}', [Microsoft.Win32.RegistryValueKind]::String)
  $k.Close()`]);
try {
  const query = await run(['query', key]);
  show('query exit', query.code);
  show('query stdout utf8', query.stdout.toString('utf8'));
  show('query stdout latin1', query.stdout.toString('latin1'));
  show('query stdout hex', query.stdout.toString('hex'));
  show('query has expand verbatim (utf8)', query.stdout.toString('utf8').includes(expand));
  const dir = mkdtempSync(path.join(tmpdir(), 'byok-e1-'));
  const file = path.join(dir, 'e.reg');
  const exported = await run(['export', key, file, '/y']);
  show('export exit', exported.code);
  show('export stdout', exported.stdout.toString('utf8'));
  const bytes = readFileSync(file);
  show('export bom', bytes.subarray(0, 2).toString('hex'));
  const text = bytes.toString('utf16le');
  show('export text', text);
  const hex2 = /"Path"=hex\(2\):([0-9a-f,\\\r\n ]+)/iu.exec(text);
  const decoded = hex2 === null ? null : Buffer.from(hex2[1].replace(/[\\\r\n ]/gu, '').split(',').filter(Boolean).map((b) => parseInt(b, 16))).toString('utf16le').replace(/\0+$/u, '');
  show('export Path decoded', decoded);
  show('export Path verbatim', decoded === expand);
  show('export PATHEXT verbatim', text.includes(`"PATHEXT"="${plain.replaceAll('\\', '\\\\')}"`));
  const missing = await run(['query', 'HKCU\\Software\\byok-e1-missing']);
  show('missing key query exit', missing.code);
  const missingExport = await run(['export', 'HKCU\\Software\\byok-e1-missing', path.join(dir, 'm.reg'), '/y']);
  show('missing key export exit', missingExport.code);
  const real = await run(['export', 'HKCU\\Environment', path.join(dir, 'u.reg'), '/y']);
  show('HKCU\\Environment export exit', real.code);
  show('HKCU\\Environment export', readFileSync(path.join(dir, 'u.reg')).toString('utf16le'));
  const machine = await run(['export', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', path.join(dir, 'm2.reg'), '/y']);
  show('HKLM Environment export exit', machine.code);
  show('HKLM Environment export', readFileSync(path.join(dir, 'm2.reg')).toString('utf16le'));
  rmSync(dir, { recursive: true, force: true });
} finally {
  execFileSync(reg, ['delete', key, '/f']);
}
