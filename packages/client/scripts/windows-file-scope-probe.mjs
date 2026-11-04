// #1423 PR-2a evidence probe. Diagnostic only, never merged.
// Checks the H1-H6 assumptions of the Windows file-scope guard against real
// NTFS files, using only the Node built-ins the guard uses (lstat, stat,
// realpath.native, open). It asserts nothing: every observation is printed as
// one JSON line and written to the job summary, and the numbers go to #1423.
// Run it under each runtime the guard can run in: `node <this>`, `bun <this>`.
import { execFileSync } from 'node:child_process';
import { appendFileSync, constants, realpath as realpathCallback, writeFileSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'win32') throw new Error('Windows only');
const runtime = typeof Bun === 'undefined' ? `node ${process.versions.node}` : `bun ${Bun.version}`;
const realpathNative = promisify(realpathCallback.native);
const system32 = path.win32.join(process.env.SystemRoot, 'System32');
const CMD = path.win32.join(system32, 'cmd.exe');
const FSUTIL = path.win32.join(system32, 'fsutil.exe');
const MOUNTVOL = path.win32.join(system32, 'mountvol.exe');
const COMPACT = path.win32.join(system32, 'compact.exe');

const rows = [];
function record(h, item, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  rows.push({ h, item, text });
  console.log(JSON.stringify({ runtime, h, item, value }));
}

// Device opens can block a threadpool thread; a timeout keeps the probe moving.
async function attempt(fn, ms = 5_000) {
  let timer;
  try {
    const ok = await Promise.race([
      fn(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms); }),
    ]);
    return { ok };
  } catch (error) {
    return { err: error?.code ?? error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}
const show = (result) => (result.err !== undefined ? `ERR ${result.err}` : result.ok);

const kindOf = (s) => (s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other');
const view = (s) => ({ kind: kindOf(s), dev: String(s.dev), ino: String(s.ino), nlink: String(s.nlink), size: String(s.size) });
const lst = (p) => attempt(async () => view(await lstat(p, { bigint: true })));
const sta = (p) => attempt(async () => view(await stat(p, { bigint: true })));
const rp = (p) => attempt(() => realpathNative(p));
const ls = async (dir) => (await readdir(dir)).sort();

function tool(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    return `ERR exit=${error.status ?? error.code} ${String(error.stdout ?? '').trim()} ${String(error.stderr ?? '').trim()}`.trim();
  }
}
const reparseTag = (p) => {
  const out = tool(FSUTIL, ['reparsepoint', 'query', p]);
  return /0x[0-9a-f]{8}/i.exec(out)?.[0].toLowerCase() ?? `none (${out.split(/\r?\n/u)[0]})`;
};

const cBase = await mkdtemp(path.join(os.tmpdir(), 'p1423-'));
const runnerTemp = process.env.RUNNER_TEMP;
const dBase = runnerTemp !== undefined && path.parse(runnerTemp).root.toUpperCase() !== path.parse(cBase).root.toUpperCase()
  ? await mkdtemp(path.join(runnerTemp, 'p1423-'))
  : undefined;
// %~sI expands a path to its 8.3 form, or echoes it when a segment has none.
const shortCmd = path.join(cBase, 'short.cmd');
writeFileSync(shortCmd, '@for %%I in (%1) do @echo %%~sI\r\n');
const shortName = (p) => tool(CMD, ['/d', '/c', shortCmd, p]);
const mounts = [];

try {
  record('env', 'runtime', runtime);
  record('env', 'os', `${os.type()} ${os.release()} ${os.version?.() ?? ''}`);
  record('env', 'os.tmpdir()', os.tmpdir());
  record('env', 'cBase / dBase', { cBase, dBase: dBase ?? 'no second volume' });
  record('env', 'fs.constants.O_NOFOLLOW', String(constants.O_NOFOLLOW));
  record('env', '8dot3name C:', tool(FSUTIL, ['8dot3name', 'query', path.parse(cBase).root.slice(0, 2)]).replace(/\s+/gu, ' '));
  if (dBase !== undefined) record('env', `8dot3name ${path.parse(dBase).root.slice(0, 2)}`, tool(FSUTIL, ['8dot3name', 'query', path.parse(dBase).root.slice(0, 2)]).replace(/\s+/gu, ' '));
  record('env', 'fs type', { c: tool(FSUTIL, ['fsinfo', 'volumeinfo', path.parse(cBase).root]).match(/File System Name : (\S+)/u)?.[1] ?? 'unknown' });

  // ---- H1: junctions and symlinks under lstat ----
  const target = path.join(cBase, 'h1-target');
  await mkdir(target);
  await writeFile(path.join(target, 'inner.txt'), 'inner');
  const fileTarget = path.join(cBase, 'h1-target.txt');
  await writeFile(fileTarget, 'file target');
  const targetStat = await sta(target);
  const fileTargetStat = await sta(fileTarget);
  record('H1', 'target dir stat', show(targetStat));
  record('H1', 'target file stat', show(fileTargetStat));
  const links = [
    ['junction (fs.symlink junction)', path.join(cBase, 'h1-junction'), () => symlink(target, path.join(cBase, 'h1-junction'), 'junction')],
    ['junction (mklink /J)', path.join(cBase, 'h1-mklink-j'), async () => { const out = tool(CMD, ['/d', '/c', 'mklink', '/J', path.join(cBase, 'h1-mklink-j'), target]); if (out.startsWith('ERR')) throw new Error(out); }],
    ['dir symlink', path.join(cBase, 'h1-dirlink'), () => symlink(target, path.join(cBase, 'h1-dirlink'), 'dir')],
    ['file symlink', path.join(cBase, 'h1-filelink'), () => symlink(fileTarget, path.join(cBase, 'h1-filelink'), 'file')],
    ['relative dir symlink', path.join(cBase, 'h1-reldirlink'), () => symlink('h1-target', path.join(cBase, 'h1-reldirlink'), 'dir')],
  ];
  if (dBase !== undefined) {
    const dTarget = path.join(dBase, 'd-target');
    await mkdir(dTarget);
    await writeFile(path.join(dTarget, 'inner.txt'), 'inner on second volume');
    links.push(['junction to second volume', path.join(cBase, 'h1-junction-d'), () => symlink(dTarget, path.join(cBase, 'h1-junction-d'), 'junction')]);
  }
  for (const [label, linkPath, create] of links) {
    const created = await attempt(create);
    if (created.err !== undefined) { record('H1', `${label}: create`, `ERR ${created.err}`); continue; }
    record('H1', `${label}: lstat`, show(await lst(linkPath)));
    record('H1', `${label}: stat`, show(await sta(linkPath)));
    record('H1', `${label}: reparse tag`, reparseTag(linkPath));
    record('H1', `${label}: readlink`, show(await attempt(() => readlink(linkPath))));
    record('H1', `${label}: realpath.native`, show(await rp(linkPath)));
    if (label === 'file symlink') {
      // The guard opens an existing regular file with O_RDONLY | O_NOFOLLOW and compares fstat.
      const opened = await attempt(async () => {
        const handle = await open(linkPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { return view(await handle.stat({ bigint: true })); } finally { await handle.close(); }
      });
      record('H1', `${label}: open O_RDONLY|O_NOFOLLOW then fstat`, show(opened));
    } else {
      record('H1', `${label}: lstat of child through link`, show(await lst(path.join(linkPath, 'inner.txt'))));
      record('H1', `${label}: realpath.native of child`, show(await rp(path.join(linkPath, 'inner.txt'))));
    }
  }

  // ---- H2: realpath.native, 8.3 names and case ----
  const mixed = path.join(cBase, 'MixedCase Folder', 'Long Directory Alpha');
  await mkdir(mixed, { recursive: true });
  const longFile = path.join(mixed, 'Long File Name Alpha.txt');
  await writeFile(longFile, 'alpha');
  const shortFile = shortName(longFile);
  const shortDir = shortName(mixed);
  record('H2', 'long file', longFile);
  record('H2', '8.3 form of long file (cmd %~sI)', shortFile);
  record('H2', '8.3 form of long dir', shortDir);
  const first = await rp(shortFile);
  const second = await rp(shortFile);
  record('H2', 'realpath.native(8.3 file) #1', show(first));
  record('H2', 'realpath.native(8.3 file) #2', show(second));
  record('H2', 'two resolutions byte-identical', String(first.ok !== undefined && first.ok === second.ok));
  record('H2', 'realpath.native(8.3 file) === long path', String(first.ok === longFile));
  const dirFirst = await rp(shortDir);
  const dirSecond = await rp(shortDir);
  record('H2', 'realpath.native(8.3 dir) #1 / #2 identical', { value: show(dirFirst), identical: dirFirst.ok === dirSecond.ok });
  record('H2', 'realpath.native(lower-cased long file)', show(await rp(longFile.toLowerCase())));
  record('H2', 'realpath.native(upper-cased long file)', show(await rp(longFile.toUpperCase())));
  record('H2', 'realpath.native(forward slashes)', show(await rp(longFile.replaceAll('\\', '/'))));
  record('H2', 'realpath.native(lower-case drive letter)', show(await rp(longFile[0].toLowerCase() + longFile.slice(1))));
  record('H2', 'realpath.native(os.tmpdir())', show(await rp(os.tmpdir())));
  record('H2', 'realpath JS (non-native) of 8.3 file', show(await attempt(() => promisify(realpathCallback)(shortFile))));
  record('H2', 'lstat(8.3 dir) / lstat(long dir)', { short: show(await lst(shortDir)), long: show(await lst(mixed)) });
  record('H2', 'realpath.native(missing leaf under 8.3 dir)', show(await rp(path.join(shortDir, 'missing.txt'))));

  // ---- H3: an 8.3 alias used as a create target ----
  for (const [volume, base] of [['C', cBase], ['D', dBase]]) {
    if (base === undefined) continue;
    const dir = path.join(base, 'h3');
    await mkdir(dir);
    const alpha = path.join(dir, 'Long File Name Alpha.txt');
    await writeFile(alpha, 'alpha');
    const aliasPath = shortName(alpha);
    const alias = path.basename(aliasPath);
    record('H3', `${volume}: existing long name / its 8.3 alias`, { long: path.basename(alpha), alias });
    if (alias === path.basename(alpha)) {
      record('H3', `${volume}: no 8.3 alias generated`, 'skipped alias create cases on this volume');
    } else {
      record('H3', `${volume}: open(alias, 'wx')`, show(await attempt(async () => { await (await open(path.join(dir, alias), 'wx')).close(); return 'created'; })));
      record('H3', `${volume}: entries after wx`, await ls(dir));
      record('H3', `${volume}: open(alias, 'w') + write 'via-alias'`, show(await attempt(async () => { await writeFile(path.join(dir, alias), 'via-alias'); return 'written'; })));
      record('H3', `${volume}: long file content / entries`, { content: await readFile(alpha, 'utf8'), entries: await ls(dir) });
      record('H3', `${volume}: lstat(alias) vs lstat(long)`, { alias: show(await lst(path.join(dir, alias))), long: show(await lst(alpha)) });
    }
    // An 8.3-form name nothing owns yet: Win32 takes it literally.
    const unowned = alias.replace(/~\d+/u, '~7');
    const unownedName = unowned === alias ? 'LONGFI~7.TXT' : unowned;
    record('H3', `${volume}: open('${unownedName}', 'wx') with no owner`, show(await attempt(async () => { await (await open(path.join(dir, unownedName), 'wx')).close(); return 'created'; })));
    const beta = path.join(dir, 'Long File Name Beta.txt');
    await writeFile(beta, 'beta');
    record('H3', `${volume}: entries after literal create + new long name`, { entries: await ls(dir), betaAlias: path.basename(shortName(beta)) });
    const longDir = path.join(dir, 'Long Directory Alpha');
    await mkdir(longDir);
    const dirAlias = path.basename(shortName(longDir));
    if (dirAlias !== path.basename(longDir)) {
      record('H3', `${volume}: mkdir(dir alias '${dirAlias}')`, show(await attempt(async () => { await mkdir(path.join(dir, dirAlias)); return 'created'; })));
      record('H3', `${volume}: open(dir alias, 'wx')`, show(await attempt(async () => { await (await open(path.join(dir, dirAlias), 'wx')).close(); return 'created'; })));
    }
  }

  // ---- H4: dev, ino, nlink ----
  const h4 = path.join(cBase, 'h4');
  await mkdir(h4);
  const h4File = path.join(h4, 'Identity File Name.txt');
  await writeFile(h4File, 'identity');
  const a1 = await sta(h4File);
  const a2 = await sta(h4File);
  record('H4', 'stat #1 / #2', { first: show(a1), second: show(a2) });
  record('H4', 'fstat', show(await attempt(async () => { const h = await open(h4File, 'r'); try { return view(await h.stat({ bigint: true })); } finally { await h.close(); } })));
  record('H4', 'stat via 8.3 path / upper-case path', { short: show(await sta(shortName(h4File))), upper: show(await sta(h4File.toUpperCase())) });
  const renamed = path.join(h4, 'renamed.txt');
  await rename(h4File, renamed);
  record('H4', 'stat after rename in the same directory', show(await sta(renamed)));
  const hard = path.join(h4, 'hardlink.txt');
  record('H4', 'link()', show(await attempt(async () => { await link(renamed, hard); return 'linked'; })));
  record('H4', 'nlink original / hardlink (lstat)', { original: show(await lst(renamed)), hardlink: show(await lst(hard)) });
  record('H4', 'ino > 2^53', String(a1.ok !== undefined && BigInt(a1.ok.ino) > 2n ** 53n));
  if (dBase !== undefined) {
    const dFile = path.join(dBase, 'd-file.txt');
    await writeFile(dFile, 'second volume');
    record('H4', 'dev C-volume file / D-volume file', { c: show(await sta(renamed)), d: show(await sta(dFile)) });
    record('H4', 'cross-volume link()', show(await attempt(async () => { await link(dFile, path.join(cBase, 'h4', 'cross.txt')); return 'linked'; })));
  }
  record('H4', 'stat of dir via junction vs target (dev/ino)', { junction: show(await sta(path.join(cBase, 'h1-junction'))), target: show(targetStat) });

  // ---- H5: names Win32 rewrites without a syntax rule ----
  const h5 = path.join(cBase, 'h5');
  await mkdir(h5);
  const main = path.join(h5, 'a.txt');
  await writeFile(main, 'main');
  const before = await lst(main);
  const viaCreate = async (name) => {
    const target = path.join(h5, name);
    const beforeLst = await lst(target);
    const opened = await attempt(async () => {
      const handle = await open(target, 'wx');
      try { return { fstat: view(await handle.stat({ bigint: true })) }; } finally { await handle.close(); }
    });
    record('H5', `'${name}': lstat before / open wx`, { lstatBefore: show(beforeLst), open: show(opened) });
    record('H5', `'${name}': realpath.native / entries after`, { realpath: show(await rp(target)), entries: await ls(h5) });
  };
  record('H5', 'a.txt before streams', show(before));
  await viaCreate('a.txt:stream');
  record('H5', 'a.txt after ADS create (size, ino) / ADS content', { main: show(await lst(main)), ads: show(await attempt(() => readFile(path.join(h5, 'a.txt:stream'), 'utf8'))) });
  record('H5', 'lstat(a.txt::$DATA)', show(await lst(path.join(h5, 'a.txt::$DATA'))));
  await viaCreate('b.txt:stream');
  for (const name of ['NUL', 'nul.txt', 'CON', 'CON.txt', 'PRN', 'AUX.log', 'COM0', 'COM1', 'COM\u00b9', 'COM\u00b2', 'LPT\u00b3', 'LPT0', 'LPT1.txt', 'CONIN$', 'CONOUT$']) {
    await viaCreate(name);
  }
  await viaCreate('trail.');
  await viaCreate('space ');
  await viaCreate('dots. .');
  await writeFile(path.join(h5, 'x.txt'), 'x');
  record('H5', "existing 'x.txt': lstat('x.txt.') / lstat('x.txt ') / lstat('x.txt')", {
    dot: show(await lst(path.join(h5, 'x.txt.'))), space: show(await lst(path.join(h5, 'x.txt '))), plain: show(await lst(path.join(h5, 'x.txt'))),
  });
  const verbatim = `\\\\?\\${h5}\\lit.`;
  record('H5', "open('\\\\?\\…\\lit.', 'wx')", show(await attempt(async () => { await (await open(verbatim, 'wx')).close(); return 'created'; })));
  record('H5', "entries / lstat('lit.') via Win32 path", { entries: await ls(h5), lstat: show(await lst(path.join(h5, 'lit.'))) });
  await attempt(() => rm(verbatim, { force: true }));
  // Other spellings of the same file.
  const drive = h5.slice(0, 2);
  const spellings = {
    'verbatim \\\\?\\': `\\\\?\\${main}`,
    'device \\\\.\\': `\\\\.\\${main}`,
    'UNC admin share': `\\\\localhost\\${drive[0]}$${main.slice(2)}`,
    'verbatim UNC': `\\\\?\\UNC\\localhost\\${drive[0]}$${main.slice(2)}`,
    'GLOBALROOT': `\\\\?\\GLOBALROOT\\??\\${main}`,
  };
  for (const [label, spelling] of Object.entries(spellings)) {
    record('H5', `${label}: lstat / realpath.native`, { path: spelling, lstat: show(await lst(spelling)), realpath: show(await rp(spelling)) });
  }
  record('H5', 'path.win32.resolve samples', {
    driveRelative: path.win32.resolve(main, `${drive}foo`),
    rootRelative: path.win32.resolve(main, '\\foo'),
    dot: path.win32.resolve(h5, '.'),
    ads: path.win32.resolve(h5, 'a.txt:stream'),
    trailingDot: path.win32.resolve(h5, 'trail.'),
    verbatim: path.win32.resolve(h5, '\\\\?\\C:\\x\\..\\y'),
    unc: path.win32.resolve(h5, '\\\\server\\share\\x'),
  });

  // ---- H6: other reparse points ----
  record('H6', 'symlink / junction tags', { dirSymlink: reparseTag(path.join(cBase, 'h1-dirlink')), junction: reparseTag(path.join(cBase, 'h1-junction')) });
  if (dBase !== undefined) {
    const volume = tool(MOUNTVOL, [path.parse(dBase).root, '/L']);
    record('H6', `volume GUID of ${path.parse(dBase).root}`, volume);
    const mnt = path.join(cBase, 'h6-mnt');
    await mkdir(mnt);
    const mounted = /^\\\\\?\\Volume\{/u.test(volume) ? tool(MOUNTVOL, [`${mnt}\\`, volume]) : `ERR no volume GUID`;
    if (mounted.startsWith('ERR')) {
      record('H6', 'volume mount point: mountvol', mounted);
    } else {
      mounts.push(mnt);
      const dRelative = dBase.slice(3);
      record('H6', 'volume mount point: reparse tag', reparseTag(mnt));
      record('H6', 'volume mount point: lstat / stat', { lstat: show(await lst(mnt)), stat: show(await sta(mnt)) });
      record('H6', 'volume mount point: readlink / realpath.native', { readlink: show(await attempt(() => readlink(mnt))), realpath: show(await rp(mnt)) });
      record('H6', 'file under mount point: lstat / realpath.native', {
        path: path.join(mnt, dRelative, 'd-file.txt'),
        lstat: show(await lst(path.join(mnt, dRelative, 'd-file.txt'))),
        realpath: show(await rp(path.join(mnt, dRelative, 'd-file.txt'))),
        direct: show(await sta(path.join(dBase, 'd-file.txt'))),
      });
      const unmounted = tool(MOUNTVOL, [`${mnt}\\`, '/D']);
      record('H6', 'volume mount point: unmount', unmounted || 'ok');
      if (!unmounted.startsWith('ERR')) mounts.pop();
    }
  } else {
    record('H6', 'volume mount point', '未测 (no second volume)');
  }
  const appDirs = [path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps')];
  let appLink;
  for (const dir of appDirs) {
    const entries = await attempt(() => readdir(dir));
    record('H6', `AppExecLink dir ${dir}`, entries.err !== undefined ? `ERR ${entries.err}` : entries.ok.filter((e) => e.endsWith('.exe')).slice(0, 10));
    for (const entry of entries.ok ?? []) {
      if (!entry.endsWith('.exe')) continue;
      const candidate = path.join(dir, entry);
      if (reparseTag(candidate) === '0x8000001b') { appLink = candidate; break; }
    }
    if (appLink !== undefined) break;
  }
  if (appLink === undefined) {
    record('H6', 'AppExecLink', '未测 (no IO_REPARSE_TAG_APPEXECLINK file on the runner)');
  } else {
    record('H6', `AppExecLink ${appLink}`, { lstat: show(await lst(appLink)), stat: show(await sta(appLink)), readlink: show(await attempt(() => readlink(appLink))), realpath: show(await rp(appLink)) });
  }
  // WOF (compact /EXE) stores a file behind a non-redirecting reparse point.
  const wof = path.join(cBase, 'h6-wof.bin');
  await writeFile(wof, Buffer.alloc(256 * 1024, 'compressible '));
  const wofBefore = await sta(wof);
  record('H6', 'WOF: compact /EXE', tool(COMPACT, ['/c', '/exe:xpress4k', wof]).split(/\r?\n/u).filter(Boolean).slice(-2).join(' | '));
  record('H6', 'WOF: reparse tag', reparseTag(wof));
  record('H6', 'WOF: lstat / realpath.native / ino before', { lstat: show(await lst(wof)), realpath: show(await rp(wof)), before: show(wofBefore) });
  record('H6', 'OneDrive placeholder (cloud files)', '未测 (no cloud files provider on the runner)');
  record('H6', 'Data Deduplication', '未测 (feature not installed on the runner)');
} finally {
  // A recursive rm must never walk through a still-mounted second volume.
  const stillMounted = mounts.filter((mnt) => tool(MOUNTVOL, [`${mnt}\\`, '/D']).startsWith('ERR'));
  if (stillMounted.length > 0) console.error(`left ${cBase} in place: could not unmount ${stillMounted.join(', ')}`);
  else await rm(cBase, { recursive: true, force: true }).catch((error) => console.error(`cleanup ${cBase}: ${error.code}`));
  if (dBase !== undefined) await rm(dBase, { recursive: true, force: true }).catch((error) => console.error(`cleanup ${dBase}: ${error.code}`));
}

const cell = (value) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
const summary = [`### #1423 PR-2a file-scope probe (${runtime})`, '', '| H | item | observed |', '|---|---|---|',
  ...rows.map((row) => `| ${row.h} | ${cell(row.item)} | ${cell(row.text)} |`), ''].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
// A device open that timed out may still hold a threadpool thread.
process.exit(0);
