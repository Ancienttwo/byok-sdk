// DIAG #1373 round E5 (do not merge), per the decision comment 6596393743:
//   1 owner via `cacls <dir> /S` (O:<SID>?), non-ASCII path, exit codes on missing / denied
//   2 OWNER RIGHTS (S-1-3-4) RC ACE: can the owner still rewrite the DACL?
//   3 reparse: fs.readdir(parent, {withFileTypes}) vs FileSystemObject Attributes & 0x400
//   4 cscript + WMI GetSecurityDescriptor: cold cost, owner/ACE parity with the product query, codes
//   5 Credential Manager PowerShell cold cost (available() + get()) in the same job
// Cold order in a fresh account: cacls, cscript(WMI), cscript(FSO), then the first
// PowerShell process of the account is the Credential Manager one. Spawns mirror
// runCommand. No product code is changed.
import { spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = process.argv[2];
const sys32 = path.win32.join(process.env.SystemRoot, 'System32');
const exe = name => path.win32.join(sys32, name);
const powershell = path.win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const wsh = path.resolve('.github/diag-1373/wsh-acl.js');
const t0 = Date.now();
const log = msg => console.log(`[probe5] t+${Date.now() - t0}ms ${msg}`);
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
      stdout: Buffer.concat(out).toString('latin1').trim(),
      stderr: Buffer.concat(err).toString('latin1').trim(),
    }));
    child.stdin.end(stdin ?? '');
  });
}

const lf = text => text.replace(/\r\n/gu, '\n');
const aclSource = lf(readFileSync('packages/keys/src/pi-provider-launcher-core.ts', 'utf8'));
const aclMatch = /const WINDOWS_PROJECTION_ACL_SCRIPT = String\.raw`([\s\S]*?)\n`;/u.exec(aclSource);
if (!aclMatch) throw new Error('product ACL script not found');
const aclEncoded = Buffer.from(`${aclMatch[1]}\n`, 'utf16le').toString('base64');
const psQuery = target => run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', aclEncoded], target);
const credSource = lf(readFileSync('packages/keys/src/windows-credential-manager.ts', 'utf8'));
const credMatch = /const WINDOWS_CREDENTIAL_MANAGER_SCRIPT_BASE64 = Buffer\.from\(\n  String\.raw`([\s\S]*?)`,\n  'utf16le',\n\)\.toString\('base64'\);/u.exec(credSource);
if (!credMatch) throw new Error('product credential script not found');
const credEncoded = Buffer.from(credMatch[1], 'utf16le').toString('base64');
const cred = request => run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', credEncoded], JSON.stringify(request));
const credAvailable = () => run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major']);

const cacls = target => run(exe('cacls.exe'), [target, '/S']);
const caclsSddl = stdout => /"([^"]*)"\s*$/u.exec(stdout)?.[1];
const wmiSd = target => run(exe('cscript.exe'), ['//NoLogo', wsh, 'sd', target]);
const fsoAttr = target => run(exe('cscript.exe'), ['//NoLogo', wsh, 'attr', target]);
const sidFromWhoami = stdout => /,"(S-1-[0-9-]+)"\s*$/u.exec(stdout)?.[1];

const key = r => `${r.sid}|${r.allow}|${r.fullControl}|${r.inherits}`;
const fromWmi = ace => ({
  sid: ace.sid, allow: ace.type === 0, fullControl: (ace.mask & 0x1f01ff) === 0x1f01ff,
  inherits: (ace.flags & 3) === 3 && (ace.flags & 0xc) === 0,
});
const ALIASES = { SY: 'S-1-5-18', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', AU: 'S-1-5-11', WD: 'S-1-1-0', CO: 'S-1-3-0', OW: 'S-1-3-4' };
const ownerOf = sddl => { const m = /^O:(S-1-[0-9-]+|[A-Z]{2})/u.exec(sddl ?? ''); return m ? (ALIASES[m[1]] ?? m[1]) : null; };

// ------------------------------------------------ cold sequence
log(`[cold] begin node=${process.version} tmp=${os.tmpdir()}`);
const dirA = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-e5-')));
const caclsCold = await cacls(dirA);
const wmiCold = await wmiSd(dirA);
const fsoCold = await fsoAttr(dirA);
const availCold = await credAvailable();
const getCold = await cred({ operation: 'get', target: 'byok.diag1373.absent', username: 'local-device' });
const caclsWarm = await cacls(dirA);
const wmiWarm = await wmiSd(dirA);
const fsoWarm = await fsoAttr(dirA);
const setRes = await cred({ operation: 'set', target: 'byok.diag1373.present', username: 'local-device', secret_base64: Buffer.from('diag-not-a-secret').toString('base64') });
const getWarm = await cred({ operation: 'get', target: 'byok.diag1373.present', username: 'local-device' });
const delRes = await cred({ operation: 'delete', target: 'byok.diag1373.present', username: 'local-device' });
const aclPsAfterCred = await psQuery(dirA);
const whoami = await run(exe('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
const userSid = sidFromWhoami(whoami.stdout);
log(`[e5-1] cacls cold code=${caclsCold.code} ms=${caclsCold.ms} stdout=${q(caclsCold.stdout)} stderr=${q(caclsCold.stderr)}`);
log(`[e5-4] wmi cold code=${wmiCold.code} ms=${wmiCold.ms} stdout=${q(wmiCold.stdout)} stderr=${q(wmiCold.stderr)}`);
log(`[e5-3] fso cold code=${fsoCold.code} ms=${fsoCold.ms} stdout=${q(fsoCold.stdout)}`);
log(`[e5-5] cred available cold code=${availCold.code} ms=${availCold.ms}; get-absent code=${getCold.code} ms=${getCold.ms} stderr=${q(getCold.stderr)}`);
log(`[e5-5] cred set code=${setRes.code} ms=${setRes.ms}; get-present code=${getWarm.code} ms=${getWarm.ms} roundtrip=${Buffer.from(getWarm.stdout, 'base64').toString() === 'diag-not-a-secret'}; delete code=${delRes.code} ms=${delRes.ms}`);
log(`[e5-5] acl ps after cred code=${aclPsAfterCred.code} ms=${aclPsAfterCred.ms}`);
log(`[cold] SUMMARY cacls_cold=${caclsCold.ms} wmi_cold=${wmiCold.ms} fso_cold=${fsoCold.ms} cacls_warm=${caclsWarm.ms} wmi_warm=${wmiWarm.ms} fso_warm=${fsoWarm.ms} cred_available_cold=${availCold.ms} cred_get_absent=${getCold.ms} cred_get_present=${getWarm.ms} cred_cold_path=${(availCold.ms + getCold.ms).toFixed(3)} acl_ps_after_cred=${aclPsAfterCred.ms}`);

const protect = (dir, ...more) => run(exe('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`,
  '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F', ...more]);

// ------------------------------------------------ 1 + 4: owner and ACE parity
async function parity(label, target) {
  const c = await cacls(target);
  const w = await wmiSd(target);
  const ps = await psQuery(target);
  const sddl = caclsSddl(c.stdout);
  let truth; try { truth = JSON.parse(ps.stdout); } catch { truth = undefined; }
  const caclsOwner = ownerOf(sddl);
  let wmiVerdict = 'n/a'; let wmiOwner = null;
  if (w.code === 0) {
    try {
      const wj = JSON.parse(w.stdout);
      wmiOwner = wj.owner;
      const rules = wj.aces.map(fromWmi);
      const same = truth && q(rules.map(key).sort()) === q(truth.rules.map(key).sort());
      const prot = truth && (((wj.control & 0x1000) !== 0) === truth.protected);
      wmiVerdict = `rules=${same ? 'MATCH' : 'DIFF'} protected=${prot ? 'match' : 'DIFF'} owner=${truth && wj.owner === truth.owner ? 'match' : 'DIFF'}`;
    } catch (error) { wmiVerdict = `parse-fail ${error.message}`; }
  }
  log(`[e5-1] case=${label} cacls code=${c.code} ms=${c.ms} sddl=${q(sddl ?? null)} raw=${q(c.stdout.slice(0, 400))} stderr=${q(c.stderr)}`);
  log(`[e5-4] case=${label} wmi code=${w.code} ms=${w.ms} out=${q(w.stdout.slice(0, 600))}`);
  log(`[e5-x] case=${label} ps code=${ps.code} owner=${truth?.owner ?? null} protected=${truth?.protected ?? null}`);
  log(`[e5-1] case=${label} VERDICT cacls_owner=${caclsOwner === null ? 'ABSENT' : truth && caclsOwner === truth.owner ? 'MATCH' : `DIFF(${caclsOwner})`} | [e5-4] VERDICT wmi ${wmiVerdict}`);
}
try {
  await parity('inherited', dirA);
  const prot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-prot-')));
  await protect(prot); await parity('protected', prot);
  const deny = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-deny-')));
  await protect(deny, '/deny', '*S-1-1-0:(WD)'); await parity('protected+explicit-deny', deny);
  const mixed = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-mixed-')));
  await protect(mixed, '/grant', '*S-1-5-32-545:(OI)(IO)(RX)', '/grant', '*S-1-5-11:(NP)(M)'); await parity('protected+io+np+partial-rights', mixed);
  const nonAscii = path.join(await fs.realpath(os.tmpdir()), 'pi-acl-нет-測試-ü-🔑');
  await fs.mkdir(nonAscii); await protect(nonAscii); await parity('non-ascii-protected', nonAscii);
  await parity('owner-is-other(e5/ow-userf)', path.join(scratch, 'e5', 'ow-userf'));
} catch (error) { log(`[e5-1] ERROR ${error.stack}`); }

const e2 = path.join(scratch, 'e2');
for (const [label, target] of [
  ['missing', path.join(e2, 'absent')],
  ['parent-missing', path.join(e2, 'nope', 'absent')],
  ['parent-unreadable-absent', path.join(e2, 'locked', 'absent')],
  ['parent-unreadable-exists', path.join(e2, 'locked', 'child')],
  ['target-unreadable', path.join(e2, 'noread')],
  ['target-deny-rc', path.join(e2, 'denyrc')],
  ['file-unreadable', path.join(e2, 'noread-file.txt')],
]) {
  const c = await cacls(target);
  const w = await wmiSd(target);
  const ps = await psQuery(target);
  log(`[e5-codes] case=${label} cacls code=${c.code} stdout=${q(c.stdout.slice(0, 200))} stderr=${q(c.stderr)} | wmi code=${w.code} out=${q(w.stdout)} | ps code=${ps.code}`);
}

// ------------------------------------------------ 2: OWNER RIGHTS
const e5 = path.join(scratch, 'e5');
for (const name of ['ow', 'noow', 'ow-userf']) {
  const target = path.join(e5, name);
  const before = await cacls(target);
  const ps = await psQuery(target);
  const modify = await run(exe('icacls.exe'), [target, '/grant', '*S-1-1-0:(R)']);
  const after = await cacls(target);
  log(`[e5-2] dir=${name} psOwner=${(() => { try { return JSON.parse(ps.stdout).owner; } catch { return `ps-code-${ps.code}`; } })()} currentUser=${userSid} before=${q(caclsSddl(before.stdout) ?? before.stdout)} beforeCode=${before.code} MODIFY code=${modify.code} stdout=${q(modify.stdout)} stderr=${q(modify.stderr)} after=${q(caclsSddl(after.stdout) ?? after.stdout)}`);
}

// ------------------------------------------------ 3: reparse
const e4 = path.join(scratch, 'e4');
let entries;
try {
  entries = new Map((await fs.readdir(e4, { withFileTypes: true })).map(d => [d.name, { symlink: d.isSymbolicLink(), dir: d.isDirectory(), file: d.isFile() }]));
} catch (error) { entries = new Map(); log(`[e5-3] readdir e4 ERROR ${error.code}`); }
for (const name of ['target-dir', 'target-file.txt', 'symlink-dir', 'symlink-file.txt', 'junction', 'mount', 'tag-dir', 'tag-file.txt', 'symlink-dangling', 'junction-dangling']) {
  const target = path.join(e4, name);
  const fso = await fsoAttr(target);
  const fsu = await run(exe('fsutil.exe'), ['reparsepoint', 'query', target]);
  log(`[e5-3] name=${name} readdir=${q(entries.get(name) ?? 'not-listed')} fso code=${fso.code} ${fso.stdout} | fsutil code=${fsu.code} first=${q(fsu.stdout.split(/\r?\n/u)[0])}`);
}
for (const [label, parent] of [['parent-unlistable(e2/noread)', path.join(e2, 'noread')], ['parent-unlistable(e2/locked)', path.join(e2, 'locked')], ['parent-missing(e2/nope)', path.join(e2, 'nope')]]) {
  let res;
  try { res = `ok n=${(await fs.readdir(parent, { withFileTypes: true })).length}`; } catch (error) { res = `ERR code=${error.code} errno=${error.errno}`; }
  const fso = await fsoAttr(path.join(parent, 'x'));
  const fsoParent = await fsoAttr(parent);
  const fsu = await run(exe('fsutil.exe'), ['reparsepoint', 'query', parent]);
  log(`[e5-3] ${label} readdir=${res} fso(child) code=${fso.code} ${fso.stdout} fso(self) code=${fsoParent.code} ${fsoParent.stdout} fsutil(self) code=${fsu.code} first=${q(fsu.stdout.split(/\r?\n/u)[0])}`);
}
log('done');
