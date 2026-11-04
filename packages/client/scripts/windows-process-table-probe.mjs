// #1410 B1 evidence probe. Diagnostic only, never merged.
// Compares the Windows process table read by cscript.exe + JScript + WMI with
// the current Windows PowerShell Get-CimInstance read: cold and warm cost,
// per-pid agreement of parent pid and FILETIME creation ticks, and cscript's
// behaviour when Windows Script Host is disabled for the current user.
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Windows only');
const N = 15;
const TIMEOUT_MS = 15_000;
const systemRoot = process.env.SystemRoot;
const system32 = path.win32.join(systemRoot, 'System32');
const POWERSHELL = path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CSCRIPT = path.win32.join(system32, 'cscript.exe');
const REG = path.win32.join(system32, 'reg.exe');
const ICACLS = path.win32.join(system32, 'icacls.exe');

// The current product query, byte for byte (windows-process-table.ts).
const PS_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')];

// Same output format: "pid ppid ticks". CIM_DATETIME is local time plus a
// UTC offset in minutes with microsecond precision. JScript has no 64-bit
// integers, so ticks are whole seconds since 1601 followed by seven digits.
const JSCRIPT = [
  'try {',
  '  var wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\\\\\.\\\\root\\\\cimv2");',
  '  var rows = wmi.ExecQuery("SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process", "WQL", 48);',
  '  var out = [];',
  '  for (var e = new Enumerator(rows); !e.atEnd(); e.moveNext()) {',
  '    var p = e.item(), d = p.CreationDate, ticks = "0";',
  '    if (d !== null && d !== undefined && d !== "") {',
  '      var m = /^(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})\\.(\\d{6})([+-])(\\d{3})$/.exec(d);',
  '      if (m === null) throw new Error("bad CreationDate " + d);',
  '      var offset = (m[8] === "-" ? -1 : 1) * Number(m[9]);',
  '      var secs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000 + 11644473600 - offset * 60;',
  '      var frac = String(Number(m[7]) * 10);',
  '      while (frac.length < 7) frac = "0" + frac;',
  '      ticks = String(secs) + frac;',
  '    }',
  '    out.push(p.ProcessId + " " + p.ParentProcessId + " " + ticks);',
  '  }',
  '  WScript.StdOut.Write(out.join("\\r\\n"));',
  '} catch (err) {',
  '  WScript.StdErr.Write("process table read failed: " + (err.number >>> 0).toString(16) + " " + err.message);',
  '  WScript.Quit(2);',
  '}',
].join('\r\n');

function run(file, args) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ ms, code: error ? (error.code ?? error.signal ?? 'error') : 0, killed: error?.killed ?? false, stdout, stderr });
    });
  });
}

function parse(text) {
  const table = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (match) table.set(Number(match[1]), { parent: Number(match[2]), created: BigInt(match[3]) });
  }
  return table;
}

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { p50: Math.round(p50), max: Math.round(sorted.at(-1)), min: Math.round(sorted[0]) };
};

const lines = [];
const say = (line = '') => { lines.push(line); console.log(line); };
const ok = (r, label) => { if (r.code !== 0) throw new Error(`${label} failed: ${r.code} ${r.stderr}`); return r; };

const dir = path.join(os.tmpdir(), `byok-1410-${randomBytes(4).toString('hex')}`);
mkdirSync(dir);
const scriptPath = path.join(dir, 'process-table.js');
writeFileSync(scriptPath, JSCRIPT);
const CS_ARGS = ['//NoLogo', '//E:JScript', scriptPath];

say(`## #1410 B1 probe — ${os.release()} (${process.env.ImageOS ?? 'unknown image'}), Node ${process.version}, N=${N}`);
say(`wmic.exe present: ${existsSync(path.win32.join(system32, 'wbem', 'WMIC.exe'))}`);

// 1. Cold: the first cscript call of the job, then the first Windows PowerShell call.
const coldCs = ok(await run(CSCRIPT, CS_ARGS), 'cold cscript');
const coldPs = ok(await run(POWERSHELL, PS_ARGS), 'cold powershell');
const warm = { cs: [], ps: [] };
for (let i = 0; i < N; i += 1) {
  const order = i % 2 === 0 ? ['cs', 'ps'] : ['ps', 'cs'];
  for (const which of order) warm[which].push(ok(await run(which === 'cs' ? CSCRIPT : POWERSHELL, which === 'cs' ? CS_ARGS : PS_ARGS), which).ms);
}
// Cost of writing the script at run time into an owner-only directory (createPrivateSystemTempDir + write).
const writeCost = [];
for (let i = 0; i < N; i += 1) {
  const started = process.hrtime.bigint();
  const d = path.join(os.tmpdir(), `byok-1410w-${randomBytes(4).toString('hex')}`);
  mkdirSync(d);
  execFileSync(ICACLS, [d, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`, '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
  writeFileSync(path.join(d, 'process-table.js'), JSCRIPT, { flag: 'wx' });
  writeCost.push(Number(process.hrtime.bigint() - started) / 1e6);
  rmSync(d, { recursive: true, force: true });
}
const cs = stats(warm.cs);
const ps = stats(warm.ps);
const wc = stats(writeCost);
say();
say('| read | cold (first in job) ms | warm p50 ms | warm max ms | warm min ms |');
say('|---|---|---|---|---|');
say(`| cscript JScript WMI | ${Math.round(coldCs.ms)} | ${cs.p50} | ${cs.max} | ${cs.min} |`);
say(`| PowerShell Get-CimInstance | ${Math.round(coldPs.ms)} | ${ps.p50} | ${ps.max} | ${ps.min} |`);
say(`| mkdir + icacls + write script | ${Math.round(writeCost[0])} | ${wc.p50} | ${wc.max} | ${wc.min} |`);

// 2. Agreement: both reads started together; compare pids present in both.
const [a, b] = await Promise.all([run(CSCRIPT, CS_ARGS), run(POWERSHELL, PS_ARGS)]);
ok(a, 'compare cscript'); ok(b, 'compare powershell');
const csTable = parse(a.stdout);
const psTable = parse(b.stdout);
const common = [...csTable.keys()].filter((pid) => psTable.has(pid));
const diffs = common.filter((pid) => csTable.get(pid).parent !== psTable.get(pid).parent || csTable.get(pid).created !== psTable.get(pid).created);
const zeros = (t) => [...t].filter(([, e]) => e.created === 0n).map(([pid]) => pid);
say();
say(`Agreement: cscript rows ${csTable.size}, PowerShell rows ${psTable.size}, common pids ${common.length}, mismatches ${diffs.length}`);
say(`created=0 pids: cscript [${zeros(csTable).join(',')}], PowerShell [${zeros(psTable).join(',')}]`);
say(`ticks divisible by 10 (microsecond grain): cscript ${[...csTable.values()].every((e) => e.created % 10n === 0n)}, PowerShell ${[...psTable.values()].every((e) => e.created % 10n === 0n)}`);
for (const pid of diffs) say(`  mismatch pid ${pid}: cscript ${csTable.get(pid).parent} ${csTable.get(pid).created} / PowerShell ${psTable.get(pid).parent} ${psTable.get(pid).created} (Δticks ${csTable.get(pid).created - psTable.get(pid).created})`);
const only = (x, y) => [...x.keys()].filter((pid) => !y.has(pid));
say(`only in cscript: [${only(csTable, psTable).join(',')}]; only in PowerShell: [${only(psTable, csTable).join(',')}]`);

// 3. WSH disabled for the current user, then restored.
const KEY = 'HKCU\\Software\\Microsoft\\Windows Script Host\\Settings';
let previous;
try {
  const q = execFileSync(REG, ['query', KEY, '/v', 'Enabled'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  previous = /Enabled\s+(REG_\w+)\s+(\S+)/.exec(q)?.slice(1);
} catch { previous = undefined; }
say();
say(`WSH disabled: previous HKCU Enabled = ${previous ? previous.join(' ') : 'absent'}`);
execFileSync(REG, ['add', KEY, '/v', 'Enabled', '/t', 'REG_DWORD', '/d', '0', '/f'], { windowsHide: true, stdio: 'ignore' });
try {
  for (const label of ['first', 'second']) {
    const r = await run(CSCRIPT, CS_ARGS);
    say(`  ${label}: exit ${r.code}, killed ${r.killed}, ${Math.round(r.ms)} ms, stdout ${JSON.stringify(r.stdout.slice(0, 300))}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`);
  }
} finally {
  if (previous) execFileSync(REG, ['add', KEY, '/v', 'Enabled', '/t', previous[0], '/d', previous[1], '/f'], { windowsHide: true, stdio: 'ignore' });
  else execFileSync(REG, ['delete', KEY, '/v', 'Enabled', '/f'], { windowsHide: true, stdio: 'ignore' });
}
const after = await run(CSCRIPT, CS_ARGS);
say(`  restored: exit ${after.code}, ${Math.round(after.ms)} ms, rows ${parse(after.stdout).size}`);

rmSync(dir, { recursive: true, force: true });
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
