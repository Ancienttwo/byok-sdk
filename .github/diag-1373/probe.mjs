// DIAG #1373 (do not merge): native ACL query evidence under a fresh standard user.
//   E1 timing: whoami /user + icacls /save, cold then warm, against the product
//      PowerShell query (same job, after the native tools).
//   E2 classification: icacls exit codes for missing / unreadable shapes, next
//      to the product PowerShell exit code for the same path.
//   E3 coverage: SDDL from icacls /save, decoded by a reference decoder in this
//      file, compared with the product PowerShell JSON for the same directory.
//   E4 reparse: symlink, junction and a third-party reparse tag, seen through
//      lstat, fsutil, attrib, dir, icacls and the product PowerShell query.
// Spawns mirror packages/keys/src/command-runner.ts runCommand (env, pipes, no
// windowsHide). Nothing here changes product code or product behavior.
import { spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = process.argv[2];
const sys32 = path.win32.join(process.env.SystemRoot, 'System32');
const exe = name => path.win32.join(sys32, name);
const powershell = path.win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const t0 = Date.now();
const log = msg => console.log(`[probe] t+${Date.now() - t0}ms ${msg}`);
const q = value => JSON.stringify(value);

function run(executable, args, stdin) {
  return new Promise(resolve => {
    const started = process.hrtime.bigint();
    const ms = () => Number((process.hrtime.bigint() - started) / 1000n) / 1000;
    const child = spawn(executable, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', e => resolve({ code: 127, ms: ms(), stdout: '', stderr: e.message }));
    child.on('close', code => resolve({
      code: code ?? 1, ms: ms(),
      // Console tools write the OEM code page; latin1 keeps the bytes visible.
      stdout: Buffer.concat(out).toString('latin1').trim(),
      stderr: Buffer.concat(err).toString('latin1').trim(),
    }));
    child.stdin.end(stdin ?? '');
  });
}

const lf = text => text.replace(/\r\n/gu, '\n');
const source = lf(readFileSync('packages/keys/src/pi-provider-launcher-core.ts', 'utf8'));
const match = /const WINDOWS_PROJECTION_ACL_SCRIPT = String\.raw`([\s\S]*?)\n`;/u.exec(source);
if (!match) throw new Error('product script not found');
const encoded = Buffer.from(`${match[1]}\n`, 'utf16le').toString('base64');
const psQuery = target => run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], target);

let saveSeq = 0;
async function icaclsSave(target, extra = []) {
  const file = path.join(os.tmpdir(), `acl-save-${process.pid}-${saveSeq++}.txt`);
  const result = await run(exe('icacls.exe'), [target, '/save', file, ...extra]);
  let saved;
  try {
    const raw = await fs.readFile(file);
    const bom = raw[0] === 0xff && raw[1] === 0xfe;
    saved = { bytes: raw.length, utf16leBom: bom, lines: raw.toString('utf16le').replace(/^﻿/u, '').split(/\r?\n/u).filter(Boolean) };
    await fs.rm(file, { force: true });
  } catch (error) { saved = { error: error.code }; }
  return { ...result, saved };
}
const whoamiUser = () => run(exe('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
const sidFromWhoami = stdout => /,"(S-1-[0-9-]+)"\s*$/u.exec(stdout)?.[1];

// ---- Reference SDDL decoder (diagnostic only; fails closed on anything unknown).
const ALIASES = {
  SY: 'S-1-5-18', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', PU: 'S-1-5-32-547', BO: 'S-1-5-32-551',
  AU: 'S-1-5-11', WD: 'S-1-1-0', CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4', PS: 'S-1-5-10', NS: 'S-1-5-20',
  LS: 'S-1-5-19', IU: 'S-1-5-4', SU: 'S-1-5-6', AN: 'S-1-5-7', NU: 'S-1-5-2', ED: 'S-1-5-9', RC: 'S-1-5-12',
  AC: 'S-1-15-2-1', WR: 'S-1-5-33',
};
const RIGHTS = {
  FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0, GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000,
  RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000, CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20,
  DT: 0x40, LO: 0x80, CR: 0x100,
};
const FLAGS = new Set(['OI', 'CI', 'NP', 'IO', 'ID', 'SA', 'FA']);
function sidOf(token) {
  if (/^S-1-[0-9-]+$/u.test(token)) return token;
  if (ALIASES[token]) return ALIASES[token];
  throw new Error(`unknown sid token ${token}`);
}
function decodeSddl(sddl) {
  const parts = {};
  for (const m of sddl.matchAll(/([OGDS]):((?:\([^)]*\)|[^():])*?)(?=[OGDS]:|$)/gu)) parts[m[1]] = m[2];
  if (parts.D === undefined) throw new Error('no DACL');
  const head = /^([A-Z]*)/u.exec(parts.D)[1];
  if (head.replace(/AR|AI|P/gu, '') !== '') throw new Error(`unknown dacl flags ${head}`);
  const aces = parts.D.slice(head.length);
  if (!/^(\([^)]*\))*$/u.test(aces)) throw new Error('unparsed dacl tail');
  const rules = [];
  for (const [, body] of aces.matchAll(/\(([^)]*)\)/gu)) {
    const f = body.split(';');
    if (f.length !== 6) throw new Error(`ace field count ${f.length}: ${body}`);
    const [type, flagStr, rightStr, objGuid, inhGuid, sidTok] = f;
    if (type !== 'A' && type !== 'D') throw new Error(`unsupported ace type ${type}`);
    if (objGuid || inhGuid) throw new Error('object ace');
    const flags = flagStr.match(/../gu) ?? [];
    if (flags.join('') !== flagStr || flags.some(x => !FLAGS.has(x))) throw new Error(`unknown ace flags ${flagStr}`);
    let mask = 0;
    if (/^0x[0-9a-fA-F]+$/u.test(rightStr)) mask = Number.parseInt(rightStr, 16);
    else {
      const toks = rightStr.match(/../gu) ?? [];
      if (toks.join('') !== rightStr || toks.some(x => RIGHTS[x] === undefined)) throw new Error(`unknown rights ${rightStr}`);
      for (const x of toks) mask = (mask | RIGHTS[x]) >>> 0;
    }
    rules.push({
      sid: sidOf(sidTok), allow: type === 'A', fullControl: (mask & 0x1f01ff) === 0x1f01ff,
      inherits: flags.includes('OI') && flags.includes('CI') && !flags.includes('NP') && !flags.includes('IO'),
    });
  }
  return { owner: parts.O === undefined ? null : sidOf(parts.O), protected: head.includes('P'), rules };
}
const key = r => `${r.sid}|${r.allow}|${r.fullControl}|${r.inherits}`;

async function compare(label, target) {
  const save = await icaclsSave(target);
  const ps = await psQuery(target);
  log(`[e3] case=${label} icacls code=${save.code} ms=${save.ms} saved=${q(save.saved)} stdout=${q(save.stdout)}`);
  log(`[e3] case=${label} ps code=${ps.code} ms=${ps.ms} stdout=${ps.stdout}`);
  const sddl = save.saved.lines?.[1];
  let decoded;
  try { decoded = decodeSddl(sddl ?? ''); } catch (error) { log(`[e3] case=${label} DECODE-FAIL ${error.message}`); return; }
  let truth;
  try { truth = JSON.parse(ps.stdout); } catch { log(`[e3] case=${label} PS-NOT-JSON`); return; }
  const a = decoded.rules.map(key); const b = truth.rules.map(key);
  const sameSet = q([...a].sort()) === q([...b].sort());
  const sameOrder = q(a) === q(b);
  const ownerCmp = decoded.owner === null ? 'absent-in-sddl' : decoded.owner === truth.owner ? 'match' : `diff(${decoded.owner})`;
  log(`[e3] case=${label} VERDICT rules=${sameSet ? 'MATCH' : 'DIFF'} order=${sameOrder ? 'same' : 'differs'} protected=${decoded.protected === truth.protected ? 'match' : 'DIFF'} owner=${ownerCmp} decoded=${q(decoded)} psRules=${q(truth.rules)}`);
}

// ---------------------------------------------------------------- E1
log(`[e1] begin node=${process.version} tmp=${os.tmpdir()}`);
const e1dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-e1-')));
const wCold = await whoamiUser();
const iCold = await icaclsSave(e1dir);
const wWarm = await whoamiUser();
const iWarm = await icaclsSave(e1dir);
const parStart = Date.now();
const [wPar, iPar] = await Promise.all([whoamiUser(), icaclsSave(e1dir)]);
const parallel = Date.now() - parStart;
const pCold = await psQuery(e1dir);
const pWarm = await psQuery(e1dir);
const userSid = sidFromWhoami(wCold.stdout);
log(`[e1] whoami cold code=${wCold.code} ms=${wCold.ms} stdout=${q(wCold.stdout)} parsedSid=${userSid}`);
log(`[e1] icacls cold code=${iCold.code} ms=${iCold.ms} saved=${q(iCold.saved)}`);
log(`[e1] whoami warm code=${wWarm.code} ms=${wWarm.ms}; icacls warm code=${iWarm.code} ms=${iWarm.ms}`);
log(`[e1] parallel warm whoami ms=${wPar.ms} icacls ms=${iPar.ms} wall=${parallel}`);
log(`[e1] ps cold code=${pCold.code} ms=${pCold.ms}; ps warm code=${pWarm.code} ms=${pWarm.ms}`);
log(`[e1] SUMMARY whoami_cold=${wCold.ms} icacls_cold=${iCold.ms} native_cold_serial=${(wCold.ms + iCold.ms).toFixed(3)} whoami_warm=${wWarm.ms} icacls_warm=${iWarm.ms} native_warm_parallel_wall=${parallel} ps_cold=${pCold.ms} ps_warm=${pWarm.ms}`);

// ---------------------------------------------------------------- E2
const e2 = path.join(scratch, 'e2');
for (const [label, target] of [
  ['missing', path.join(e2, 'absent')],
  ['parent-missing', path.join(e2, 'nope', 'absent')],
  ['parent-unreadable-exists', path.join(e2, 'locked', 'child')],
  ['parent-unreadable-absent', path.join(e2, 'locked', 'absent')],
  ['target-unreadable', path.join(e2, 'noread')],
  ['target-deny-rc', path.join(e2, 'denyrc')],
  ['file-unreadable', path.join(e2, 'noread-file.txt')],
]) {
  const save = await icaclsSave(target);
  const ps = await psQuery(target);
  log(`[e2] case=${label} icacls code=${save.code} ms=${save.ms} stdout=${q(save.stdout)} stderr=${q(save.stderr)} saved=${q(save.saved)} | ps code=${ps.code} ms=${ps.ms}`);
}

// ---------------------------------------------------------------- E3
const protect = (dir, ...more) => run(exe('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`,
  '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F', ...more]);
try {
  await compare('inherited', e1dir);
  const prot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-prot-')));
  log(`[e3] setup protected code=${(await protect(prot)).code}`);
  await compare('protected', prot);
  const deny = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-deny-')));
  log(`[e3] setup deny code=${(await protect(deny, '/deny', '*S-1-1-0:(WD)')).code}`);
  await compare('protected+explicit-deny', deny);
  const mixed = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-mixed-')));
  log(`[e3] setup mixed code=${(await protect(mixed, '/grant', '*S-1-5-32-545:(OI)(IO)(RX)', '/grant', '*S-1-5-11:(NP)(M)')).code}`);
  await compare('protected+io+np+partial-rights', mixed);
  const nonAscii = path.join(await fs.realpath(os.tmpdir()), 'pi-acl-нет-測試-ü-🔑');
  await fs.mkdir(nonAscii);
  log(`[e3] setup non-ascii code=${(await protect(nonAscii)).code}`);
  await compare('non-ascii-protected', nonAscii);
  const dirq = await run(exe('cmd.exe'), ['/d', '/c', 'dir', '/q', '/a:d', os.tmpdir()]);
  log(`[e3] owner-alt dir/q code=${dirq.code} out=${q(dirq.stdout.split(/\r?\n/u).filter(l => l.includes('pi-acl')))}`);
} catch (error) { log(`[e3] ERROR ${error.stack}`); }

// ---------------------------------------------------------------- E4
const e4 = path.join(scratch, 'e4');
for (const name of ['target-dir', 'target-file.txt', 'symlink-dir', 'symlink-file.txt', 'junction', 'tag-dir', 'tag-file.txt']) {
  const target = path.join(e4, name);
  let st;
  try { const s = await fs.lstat(target); st = { symlink: s.isSymbolicLink(), dir: s.isDirectory(), file: s.isFile(), mode: s.mode.toString(8) }; } catch (error) { st = { error: error.code }; }
  let link;
  try { link = await fs.readlink(target); } catch (error) { link = `ERR:${error.code}`; }
  const fsu = await run(exe('fsutil.exe'), ['reparsepoint', 'query', target]);
  const attrib = await run(exe('attrib.exe'), ['/L', target]);
  const save = await icaclsSave(target);
  const saveL = await icaclsSave(target, ['/L']);
  const ps = await psQuery(target);
  log(`[e4] name=${name} lstat=${q(st)} readlink=${q(link)} fsutil code=${fsu.code} first=${q(fsu.stdout.split(/\r?\n/u)[0])} attrib=${q(attrib.stdout)} icacls code=${save.code} sddl=${q(save.saved.lines?.[1] ?? save.saved)} icaclsL code=${saveL.code} sddlL=${q(saveL.saved.lines?.[1] ?? saveL.saved)} ps code=${ps.code} out=${ps.stdout.slice(0, 40)}`);
}
const dir = await run(exe('cmd.exe'), ['/d', '/c', 'dir', '/a', e4]);
log(`[e4] dir listing=${q(dir.stdout.split(/\r?\n/u).filter(l => /<|tag-/u.test(l)))}`);
log('done');
