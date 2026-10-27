#!/usr/bin/env node
// Spike probe: can the byok client drive the Grok Bot desktop product
// (Cursor/Anysphere "sand", bundle id com.anysphere.sand) the way it drives a
// coding-agent CLI? It reads the installed app and the running process only.
// It never opens a grokbot:// link, never reads account secrets or
// transcripts, and never starts the app.
//
//   node scripts/spikes/grok-bot-probe.mjs [--app <path>] [--user-data <dir>]
//
// Prints one JSON report. `verdict` is `fail-closed` when no surface can submit
// a prompt without a human, `needs-review` when a candidate surface shows up
// (ACP markers, a TCP listener, a served dev control port, a submitting deep
// link), and `not-installed` (exit 3) when the app is absent.
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, readSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BUNDLE_ID = 'com.anysphere.sand';
const DEFAULT_APP = '/Applications/Grok Bot.app';
const DEFAULT_USER_DATA = path.join(os.homedir(), 'Library/Application Support/Grok Bot');

/** Electron fuse sentinel and the fuse order of fuse wire version 1. */
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const FUSE_NAMES = [
  'RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges',
];
const FUSE_STATE = { 0x30: 'off', 0x31: 'on', 0x72: 'removed' };

/** Agent Client Protocol method names; any of them in a bundle would mean an ACP surface. */
const ACP_MARKERS = ['"session/prompt"', '"session/new"', 'agent-client-protocol'];

export function parseFuses(buffer) {
  const at = buffer.indexOf(FUSE_SENTINEL);
  if (at < 0) return null;
  const base = at + FUSE_SENTINEL.length;
  const count = buffer[base + 1];
  const fuses = {};
  for (let i = 0; i < count; i++) {
    fuses[FUSE_NAMES[i] ?? `fuse${i}`] = FUSE_STATE[buffer[base + 2 + i]] ?? `0x${buffer[base + 2 + i].toString(16)}`;
  }
  return { wireVersion: buffer[base], fuses };
}

/** Reads the asar header: a Chromium pickle holding a JSON file tree. */
export function readAsarHeader(read) {
  const head = read(0, 16);
  const headerSize = head.readUInt32LE(4);
  const jsonLength = head.readUInt32LE(12);
  return { tree: JSON.parse(read(16, jsonLength).toString('utf8')), dataOffset: 8 + headerSize };
}

export function listAsarFiles(tree, prefix = '') {
  const out = [];
  for (const [name, node] of Object.entries(tree.files ?? {})) {
    const p = `${prefix}/${name}`;
    if (node.files) out.push(...listAsarFiles(node, p));
    else out.push({ path: p, size: node.size, offset: node.offset, unpacked: node.unpacked === true });
  }
  return out;
}

/** Deep-link route table of the main process: `name:fn("/v1/...",{params})`. */
export function extractDeepLinkRoutes(source) {
  const routes = {};
  for (const m of source.matchAll(/"?([a-z][a-z0-9-]*)"?:\w{1,4}\("(\/v1\/[a-z0-9/-]+)",\{/g)) routes[m[1]] = m[2];
  return routes;
}

/**
 * The renderer's handler for `grokbot://app/v1/prompt`: the outcome literals
 * it can return, read from the function that logs `no-main-agent`.
 */
export function promptLinkOutcomes(source) {
  const at = source.indexOf('deep-link: rejected reason=no-main-agent');
  if (at < 0) return null;
  const start = source.lastIndexOf('async function', at);
  const end = source.indexOf('function ', at + 200);
  const body = source.slice(start, end < 0 ? at + 2000 : end);
  return {
    outcomes: [...new Set([...body.matchAll(/`([a-z-]+)`/g)].map(m => m[1]))],
    setsDraft: body.includes('.setDraft('),
    submits: /\b(?:send|submit)[A-Z]\w*\(/.test(body),
  };
}

export function decide(evidence) {
  const channels = [];
  if (evidence.acpMarkers.length > 0) channels.push('acp');
  if (evidence.tcpListeners.length > 0) channels.push('tcp');
  if (evidence.devControlServer === 'served') channels.push('dev-control');
  const prompt = evidence.promptLink;
  if (prompt && prompt.submits) channels.push('deep-link-submit');
  return channels.length === 0 ? 'fail-closed' : 'needs-review';
}

function plist(appPath) {
  const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' });
  const p = JSON.parse(json);
  return {
    bundleId: p.CFBundleIdentifier,
    name: p.CFBundleName,
    version: p.CFBundleShortVersionString,
    urlSchemes: (p.CFBundleURLTypes ?? []).flatMap(t => t.CFBundleURLSchemes ?? []),
  };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function appPids(appPath) {
  try {
    return execFileSync('pgrep', ['-f', `${appPath}/Contents/`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  } catch { return []; }
}

function tcpListeners(pids) {
  const out = [];
  for (const pid of pids) {
    try {
      const text = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
      out.push(...text.split('\n').slice(1).filter(Boolean).map(line => ({ pid, line: line.trim() })));
    } catch { /* lsof exits 1 when the process has no match */ }
  }
  return out;
}

function grokCli() {
  try {
    const version = execFileSync('grok', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    const help = execFileSync('grok', ['--help'], { encoding: 'utf8', timeout: 5000 }).split('\n').slice(0, 3).join(' ').trim();
    return { version, product: help.includes('Grok Build') ? 'Grok Build' : help };
  } catch (error) {
    return { error: error.code ?? String(error.message).slice(0, 120) };
  }
}

export function probe({ appPath = DEFAULT_APP, userData = DEFAULT_USER_DATA } = {}) {
  if (!existsSync(path.join(appPath, 'Contents/Info.plist'))) {
    return { verdict: 'not-installed', appPath };
  }
  const bundle = plist(appPath);
  if (bundle.bundleId !== BUNDLE_ID) return { verdict: 'not-installed', appPath, bundle, reason: `bundle id is not ${BUNDLE_ID}` };

  const statusFile = path.join(userData, 'desktop-status.json');
  let status = null;
  if (existsSync(statusFile)) {
    const s = JSON.parse(readFileSync(statusFile, 'utf8'));
    status = { appVersion: s.appVersion, signedIn: s.signedIn === true, pidAlive: Number.isInteger(s.pid) && pidAlive(s.pid) };
  }

  const fuses = parseFuses(readFileSync(path.join(appPath, 'Contents/Frameworks/Electron Framework.framework/Electron Framework')));

  const asarPath = path.join(appPath, 'Contents/Resources/app.asar');
  const fd = openSync(asarPath, 'r');
  try {
    const read = (position, length) => {
      const b = Buffer.alloc(length);
      readSync(fd, b, 0, length, position);
      return b;
    };
    const { tree, dataOffset } = readAsarHeader(read);
    const files = listAsarFiles(tree);
    const text = file => read(dataOffset + Number(file.offset), file.size).toString('utf8');
    const bundles = files.filter(f => !f.unpacked && /\.(c?js)$/.test(f.path) && !f.path.includes('/locales/'));
    const mainCore = bundles.find(f => f.path === '/dist/electron-main/main-core.cjs');
    const mainApp = bundles.find(f => f.path === '/dist/electron-main/main-app.cjs');

    let promptLink = null;
    const acpMarkers = [];
    for (const f of bundles) {
      const src = text(f);
      if (promptLink === null) promptLink = promptLinkOutcomes(src);
      for (const marker of ACP_MARKERS) if (src.includes(marker)) acpMarkers.push({ file: f.path, marker });
    }
    const mainAppSrc = mainApp ? text(mainApp) : '';
    const pids = appPids(appPath);
    const evidence = {
      bundle,
      status,
      fuses,
      entrypoints: files.filter(f => /\/main\.cjs$/.test(f.path)).map(f => f.path),
      deepLinkRoutes: mainCore ? extractDeepLinkRoutes(text(mainCore)) : null,
      promptLink,
      // The dev control HTTP server starts only when the app is not packaged.
      devControlServer: mainAppSrc.includes('e.isPackaged||(e.startDevControlServer') ? 'unpackaged-only' : 'unknown',
      acpMarkers,
      runningPids: pids.length,
      tcpListeners: tcpListeners(pids),
      grokCli: grokCli(),
    };
    return { verdict: decide(evidence), ...evidence };
  } finally {
    closeSync(fd);
  }
}

function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const report = probe({ appPath: opt('--app'), userData: opt('--user-data') });
  console.log(JSON.stringify(report, null, 2));
  return report.verdict === 'not-installed' ? 3 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
