import { piExportAssetPaths } from '../adapters/pi/pi-export-assets';
import { runtimeRecordFixture } from './fixtures/runtime-resolution';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRuntimeImplementation, type ImplementationSpawnBindingV1, type ToolImplementationInstallRecordV1 } from '@byok-sdk/implementation-identity';
import { resolveInstalledPiRuntimeIdentity } from '../adapters/pi/input-preparation';
import { extractPiConfigDigest, readPiHostConfig, requirePiHostBinding, serializePiHostConfig, verifyPiHostBinding } from '../adapters/pi/runtime-host-binding';

const roots: string[] = [];
const originalArgv = process.argv;
const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath')!;
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.argv = originalArgv;
  Object.defineProperty(process, 'execPath', originalExecPath);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive:true,force:true})));
});
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(mutate: (record: ToolImplementationInstallRecordV1) => ToolImplementationInstallRecordV1 = record => record, mutateManifest: (manifest: Record<string, unknown>) => Record<string, unknown> = manifest => manifest) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pi-host-binding-'))); roots.push(root);
  const entry = path.join(root,'sdk.js'); const interpreter = path.join(root,'interpreter');
  await fs.writeFile(entry,'sealed SDK fixture',{mode:0o444}); await fs.writeFile(interpreter,'interpreter fixture',{mode:0o555});
  const native = resolveInstalledPiRuntimeIdentity();
  const manifest = mutateManifest({name:native.packageName,version:native.packageVersion,byokFork:{upstreamBase:native.upstreamBase,upstreamCommit:native.upstreamCommit,forkBuild:native.forkBuild}});
  const manifestPath = path.join(root,'package.json'); const manifestBytes = JSON.stringify(manifest);
  await fs.writeFile(manifestPath,manifestBytes,{mode:0o444});
  const exportAssets: {path:string;digest:string}[] = [];
  for (const relative of piExportAssetPaths('interpreter+bundle')) {
    const file = path.join(root,relative), bytes = `synthetic export resource ${relative}`;
    await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,bytes,{mode:0o444});
    exportAssets.push({path:relative,digest:sha(bytes)});
  }
  const lstat = fs.lstat.bind(fs);
  // Synthetic installation ownership only inside this fixture. Real bytes,
  // modes and stat tuples remain measured at resolve and child reverify.
  vi.spyOn(fs,'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args);
    return String(args[0]).startsWith(root+path.sep) ? Object.assign(stat,{uid:0}) : stat;
  }) as typeof fs.lstat);
  for (const name of Object.keys(process.env).filter(name=>name.startsWith('BYOK_'))) vi.stubEnv(name,undefined);
  for (const name of ['PI_CODING_AGENT_DIR','PI_CODING_AGENT_SESSION_DIR']) vi.stubEnv(name,undefined);
  vi.stubEnv('PI_PACKAGE_DIR',root);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1]!==undefined));
  const record = mutate({kind:'attested',authority:'host-install-record',manifestRevision:'host-config-fixture',form:'interpreter+bundle',
    installPath:entry,closureDigest:sha(await fs.readFile(entry)),closureKind:'artifact',
    interpreter:{path:interpreter,digest:sha(await fs.readFile(interpreter)),loadCommandsDigest:'0'.repeat(64)},
    launchArgv:['__byok_sdk_helper','pi-prepared'],launchCwd:root,assetRoot:root,assets:[...exportAssets,{path:'package.json',digest:sha(manifestBytes)}].sort((a,b)=>a.path<b.path?-1:1),
    nativeProvenance:{packageName:native.packageName,packageVersion:native.packageVersion,upstreamBase:native.upstreamBase,
      upstreamCommit:native.upstreamCommit,forkBuild:native.forkBuild,compilerVersion:native.compilerVersion}});
  const declaration = await resolveRuntimeImplementation({resolve:async()=>runtimeRecordFixture(record)},{subject:{kind:'runtime',runtimeId:'pi'},runtimeEntry:'pi-prepared'},env);
  expect(declaration.kind).toBe('attested');
  const identity = declaration.kind === 'attested' ? declaration.identity : declaration;
  const binding: ImplementationSpawnBindingV1 = {format:'byok.implementation-spawn',version:1,identity,command:interpreter,entry,
    fixedArgv:record.launchArgv,cwd:root,envCommitments:{PI_PACKAGE_DIR:root}};
  const configPath = path.join(root,'config.json');
  const config = {binding,cwd:path.join(root,'session'),format:'fixture'};
  const serialized = serializePiHostConfig(config); await fs.writeFile(configPath,serialized.bytes);
  process.argv = [interpreter,entry,...binding.fixedArgv,`--config-digest=${serialized.digest}`,'--config',configPath];
  Object.defineProperty(process,'execPath',{...originalExecPath,value:interpreter});
  vi.spyOn(process,'cwd').mockReturnValue(root);
  return {root,native,record,binding,config,configPath,manifestPath,serialized};
}

const digestCases = (JSON.parse(readFileSync(new URL('../../../../tests/fixtures/c07-runtime-record/rejections.v1.json', import.meta.url), 'utf8')).compositionCases as { id:string; argvCases?: {id:string;argv:string[];expectedReason:string}[] }[])
  .filter(test => test.argvCases !== undefined);

describe('Pi child launch/config authority', () => {
  it.each(digestCases)('executes frozen digest refusal family $id without enabling descendants', family => {
    for (const test of family.argvCases!) expect(() => extractPiConfigDigest(test.argv)).toThrow(test.expectedReason);
    // These are extraction reasons only. Disabled descendant hosts still reject
    // as not-enabled; their future EX_CONFIG renderers are not claimed here.
  });

  it.each([[], ['--config-digest'], ['--config-digest=x'], [`--config-digest=${'A'.repeat(64)}`],
    [`--config-digest=${'a'.repeat(64)}`,`--config-digest=${'a'.repeat(64)}`]].map(argv=>({argv})))('rejects missing, malformed or duplicate owned digest %#', ({argv}) => {
    expect(()=>extractPiConfigDigest(argv)).toThrow(/config-digest/);
  });
  it('requires the shared strict spawn binding, without config-authored fallback', () => {
    expect(()=>requirePiHostBinding(undefined)).toThrow(/config.binding/);
    expect(()=>requirePiHostBinding({identity:{kind:'unavailable',reason:'record_missing'}})).toThrow(/config.binding/);
  });
  it('verifies measured self/asset provenance and derives the native expectation', async () => {
    const f = await fixture();
    const read = readPiHostConfig(f.configPath,f.serialized.digest) as typeof f.config;
    await expect(verifyPiHostBinding(requirePiHostBinding(read.binding),'pi-prepared')).resolves.toEqual(f.native);
  });
  it('rejects an undeclared export resource in an otherwise verified child binding',async()=>{
    const f=await fixture(record=>({...record,assets:record.assets!.filter(asset=>asset.path!==piExportAssetPaths('interpreter+bundle')[0])}));
    await expect(verifyPiHostBinding(f.binding,'pi-prepared')).rejects.toThrow('pi_export_asset_undeclared');
  });
  it.each(['upstreamCommit','forkBuild','upstreamBase'] as const)('rejects changed record %s against measured manifest', async field => {
    const f = await fixture(record=>({...record,nativeProvenance:{...record.nativeProvenance!,[field]:field==='forkBuild'?99:field==='upstreamCommit'?'c'.repeat(40):'0.0.1'}}));
    await expect(verifyPiHostBinding(f.binding,'pi-prepared')).rejects.toThrow(`byokFork.${field}`);
  });
  it('rejects record and manifest against the independent static SDK pin', async () => {
    const f = await fixture(record=>({...record,nativeProvenance:{...record.nativeProvenance!,packageVersion:'9.9.9'}}), manifest=>({...manifest,version:'9.9.9'}));
    await expect(verifyPiHostBinding(f.binding,'pi-prepared')).rejects.toThrow(/packageVersion/);
  });
  it('rejects record and manifest name against the independent static SDK pin', async () => {
    const f = await fixture(record=>({...record,nativeProvenance:{...record.nativeProvenance!,packageName:'@fixture/not-pi'}}), manifest=>({...manifest,name:'@fixture/not-pi'}));
    await expect(verifyPiHostBinding(f.binding,'pi-prepared')).rejects.toThrow(/packageName/);
  });
  it('rejects a changed compiler contract', async () => {
    const f = await fixture(record=>({...record,nativeProvenance:{...record.nativeProvenance!,compilerVersion:999}}));
    await expect(verifyPiHostBinding(f.binding,'pi-prepared')).rejects.toThrow(/compiler version/);
  });
  it('rejects one changed manifest byte during asset reverify before parsing provenance', async () => {
    const f = await fixture(); await fs.chmod(f.manifestPath,0o644); await fs.appendFile(f.manifestPath,' '); await fs.chmod(f.manifestPath,0o444);
    await expect(verifyPiHostBinding(f.binding,'pi-prepared')).rejects.toThrow(/asset|reverify|mismatch/);
  });
  it.each(['binding','cwd'] as const)('rejects changed complete config bytes: %s', async field => {
    const f = await fixture();
    const changed = field==='cwd'?{...f.config,cwd:f.config.cwd+'x'}:{...f.config,binding:{...f.binding,cwd:f.binding.cwd+'x'}};
    await fs.writeFile(f.configPath,JSON.stringify(changed));
    expect(()=>readPiHostConfig(f.configPath,f.serialized.digest)).toThrow(/config byte digest mismatch/);
  });
  it.each(['command','entry','prefix','cwd'] as const)('rejects actual process %s drift before filesystem reverify', async field => {
    const f = await fixture();
    if(field==='command') Object.defineProperty(process,'execPath',{...originalExecPath,value:path.join(f.root,'other')});
    if(field==='entry') process.argv[1]=path.join(f.root,'other');
    if(field==='prefix') process.argv[2]='other';
    if(field==='cwd') vi.mocked(process.cwd).mockReturnValue(path.join(f.root,'other'));
    await expect(verifyPiHostBinding(f.binding,'pi-prepared')).rejects.toThrow(/launch description drift/);
  });
});
