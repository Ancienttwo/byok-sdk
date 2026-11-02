// DIAG #1364 verification (do not merge). One fresh account per job:
//   new-cold, new-warm, old-cold, old-warm.
// Every query goes through the product assertWindowsPiProjectionAcl (same
// validation). The runner swaps in a copy of the script with stderr [e1] marks.
// The new copy is checked to be the product script plus those marks only.
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandRunner } from '../../packages/keys/src/command-runner';
import { assertWindowsPiProjectionAcl } from '../../packages/keys/src/pi-provider-launcher-core';

const t0 = Date.now();
const log = (msg: string): void => console.log(`[ab] t+${Date.now() - t0}ms utc=${new Date().toISOString()} ${msg}`);
const mark = (name: string): string => name === 'first'
  ? "[Console]::Error.WriteLine('[e1] mark=first utc=' + [DateTime]::UtcNow.ToString('o') + ' pid=' + $PID + ' osStart=' + [System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o'))"
  : `[Console]::Error.WriteLine('[e1] mark=${name} utc=' + [DateTime]::UtcNow.ToString('o'))`;

// [anchor substring, mark name, 'before' | 'after']; every anchor must hit exactly one line.
type Anchor = [string, string, 'before' | 'after'];
function inject(script: string, anchors: Anchor[]): string {
  const lines = script.split('\n');
  for (const [anchor, name, where] of anchors) {
    const hits = lines.flatMap((line, i) => (line.includes(anchor) ? [i] : []));
    if (hits.length !== 1) throw new Error(`anchor ${JSON.stringify(anchor)} hit ${hits.length} lines`);
    lines.splice(where === 'before' ? hits[0]! : hits[0]! + 1, 0, mark(name));
  }
  return lines.join('\n');
}
const NEW_ANCHORS: Anchor[] = [
  ["$ErrorActionPreference = 'Stop'", 'first', 'before'],
  ['.ReadToEnd()', 'stdin-read', 'after'],
  ['$reparsePoint = ', 'getattributes-returned', 'after'],
  ['$acl = [System.IO.Directory]::GetAccessControl', 'getaccesscontrol-returned', 'after'],
  ['  exit 0', 'before-exit', 'before'],
];
const OLD_ANCHORS: Anchor[] = [
  ["$ErrorActionPreference = 'Stop'", 'first', 'before'],
  ['[System.Reflection.Assembly]::Load(', 'assembly-loaded', 'after'],
  ['$serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()', 'serializer-constructed', 'after'],
  ['.ReadToEnd()', 'stdin-read', 'after'],
  ['DeserializeObject(', 'deserialized', 'after'],
  ['$reparsePoint = ', 'getattributes-returned', 'after'],
  ['$acl = [System.IO.Directory]::GetAccessControl', 'getaccesscontrol-returned', 'after'],
  ['  exit 0', 'before-exit', 'before'],
];
// A Windows checkout has CRLF files; a JS template literal (raw too) normalizes to LF.
const lf = (text: string): string => text.replace(/\r\n/gu, '\n');
const source = lf(readFileSync('packages/keys/src/pi-provider-launcher-core.ts', 'utf8'));
const match = /const WINDOWS_PROJECTION_ACL_SCRIPT = String\.raw`([\s\S]*?)\n`;/u.exec(source);
if (!match) throw new Error('product script not found');
const productScript = `${match[1]}\n`;
const newScript = inject(productScript, NEW_ANCHORS);
const oldScript = inject(lf(readFileSync('.github/diag-1364/old-acl-script.ps1', 'utf8')), OLD_ANCHORS);
const encode = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

function timedRunner(label: string, variant: 'new' | 'old'): CommandRunner {
  return (executable, args, stdin) => new Promise(resolve => {
    const product = Buffer.from(args[3]!, 'base64').toString('utf16le');
    if (product !== productScript) throw new Error('product runner argv no longer carries the product script');
    const swapped = [...args.slice(0, 3), encode(variant === 'new' ? newScript : oldScript)];
    const input = variant === 'new' ? stdin! : JSON.stringify({ path: stdin });
    const started = Date.now();
    const child = spawn(executable, swapped, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    log(`probe=${label} spawned pid=${child.pid}`);
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; log(`probe=${label} stderr t=${Date.now() - started}ms ${c.trim().replace(/\r?\n/gu, ' | ')}`); });
    child.on('error', () => resolve({ exitCode: 127, stderr: 'command unavailable', stdout: '' }));
    child.on('close', code => {
      log(`probe=${label} close t=${Date.now() - started}ms code=${code}`);
      resolve({ exitCode: code ?? 1, stderr, stdout });
    });
    child.stdin.end(input);
  });
}

const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acl-ab-')));
execFileSync('icacls', [directory, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`,
  '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true });
let failed = false;
for (const [label, variant] of [['new-cold', 'new'], ['new-warm', 'new'], ['old-cold', 'old'], ['old-warm', 'old']] as const) {
  const started = Date.now();
  try {
    await assertWindowsPiProjectionAcl(directory, { run: timedRunner(label, variant) });
    log(`probe=${label} RESULT=accepted elapsed=${Date.now() - started}ms`);
  } catch (error) {
    failed = true;
    log(`probe=${label} RESULT=rejected elapsed=${Date.now() - started}ms ${(error as Error).message}`);
  }
}
await fs.rm(directory, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
