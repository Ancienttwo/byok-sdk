import { OFFICIAL_PI_PACKAGES, verifyOfficialPiClosure } from '../adapters/pi/official-pi-installation.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import { piExportAssetPaths, verifyPiExportAssets } from '../adapters/pi/pi-export-assets';
import layout from '../adapters/pi/pi-export-asset-layout.json';
import source from '../adapters/pi/pi-export-assets.source.json';

const nativeRoot = path.resolve(import.meta.dirname,'../../node_modules/@earendil-works/pi-coding-agent');
const roots: string[] = [];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function fixture(form: 'interpreter+bundle'|'compiled-executable') {
  const root=mkdtempSync(path.join(os.tmpdir(),'pi-export-assets-'));roots.push(root);
  const assets=piExportAssetPaths(form).map((relative,index)=>{
    const file=path.join(root,relative);mkdirSync(path.dirname(file),{recursive:true});
    cpSync(path.join(nativeRoot,source.sourceBasePath,layout.files[index]!),file);
    return {path:relative,digest:digest(readFileSync(file))};
  });
  // Post-binding stage only; real physical checks are exercised in the host test.
  const binding={identity:{kind:'attested',form,assetRoot:root,assets},envCommitments:{PI_PACKAGE_DIR:root}} as unknown as ImplementationSpawnBindingV1;
  return {root,binding,assets};
}

describe('required native export data assets',()=>{
  it('binds inventory to exact native pin and five unchanged upstream bytes',()=>{
    const manifest=JSON.parse(readFileSync(path.join(nativeRoot,'package.json'),'utf8'));
    expect([manifest.name,manifest.version]).toEqual([source.packageName,source.packageVersion]);
    expect(manifest.byokFork).toBeUndefined();
    expect(source.files.map(row=>row.path)).toEqual(layout.files);
    for(const row of source.files){const bytes=readFileSync(path.join(nativeRoot,source.sourceBasePath,row.path));expect(bytes.length).toBe(row.bytes);expect(digest(bytes)).toBe(row.sha256);}
  });
  it('builds both form layouts from the same measured source and rejects byte drift',()=>{
    const root=mkdtempSync(path.join(os.tmpdir(),'pi-export-build-'));roots.push(root);
    const sourceDir=path.join(root,'src/adapters/pi'),scriptDir=path.join(root,'scripts');
    mkdirSync(sourceDir,{recursive:true});mkdirSync(scriptDir,{recursive:true});
    for(const file of ['pi-export-asset-layout.json','pi-export-assets.source.json','official-pi-installation.mjs','official-pi-closure.json'])cpSync(path.resolve(import.meta.dirname,'../adapters/pi',file),path.join(sourceDir,file));
    const script=path.join(scriptDir,'build-pi-export-assets.mjs');
    cpSync(path.resolve(import.meta.dirname,'../../scripts/build-pi-export-assets.mjs'),script);
    writeFileSync(path.join(root,'package.json'),JSON.stringify({byok:{piRuntimePin:source.packageVersion}}));
    const installedRoots = verifyOfficialPiClosure(process.cwd()).roots;
    for (const name of OFFICIAL_PI_PACKAGES) {
      const installed = installedRoots.find(row => row.name === name);
      expect(installed).toBeDefined();
      const target = path.join(root,'node_modules',name); mkdirSync(path.dirname(target),{recursive:true});
      cpSync(installed!.root,target,{recursive:true});
    }
    const pinRoot=path.join(root,'node_modules/@earendil-works/pi-coding-agent');
    const run=()=>spawnSync(process.execPath,[script],{encoding:'utf8'});
    const built=run();expect(built.status,built.stderr).toBe(0);
    const output=path.join(root,'dist/assets/pi-export-html');
    const emitted=JSON.parse(readFileSync(path.join(output,'layout.json'),'utf8'));
    expect(JSON.parse(readFileSync(path.join(output,'source-manifest.json'),'utf8'))).toEqual(source);
    expect(emitted.files).toEqual(layout.files);
    for(const form of ['interpreter+bundle','compiled-executable'] as const) {
      expect(emitted.assetsByForm[form]).toEqual(source.files.map(row=>({path:`${layout.basePaths[form]}/${row.path}`,digest:row.sha256})));
    }
    const file=path.join(pinRoot,source.sourceBasePath,source.files[0]!.path),bytes=readFileSync(file);
    const changed=Buffer.from(bytes);changed[0]=changed[0]!^1;writeFileSync(file,changed);
    const failed=run();expect(failed.status).not.toBe(0);expect(failed.stderr).toMatch(/official Pi file digest mismatch|export resource digest drift/);
  });
  it.each(['interpreter+bundle','compiled-executable'] as const)('verifies exact declared resources for %s',form=>{
    const f=fixture(form);expect(()=>verifyPiExportAssets(f.binding)).not.toThrow();
    expect(f.assets).toHaveLength(5);
  });
  it.each(['interpreter+bundle','compiled-executable'] as const)('rejects each missing/tampered/undeclared/duplicate resource for %s',form=>{
    const f=fixture(form);
    for(const row of [...f.assets]) {
      const file=path.join(f.root,row.path),bytes=readFileSync(file),index=f.assets.indexOf(row);
      unlinkSync(file);expect(()=>verifyPiExportAssets(f.binding)).toThrow();
      writeFileSync(file,Buffer.concat([bytes,Buffer.from(' ')]));expect(()=>verifyPiExportAssets(f.binding)).toThrow('pi_export_asset_digest_mismatch');
      writeFileSync(file,bytes);f.assets.splice(index,1);expect(()=>verifyPiExportAssets(f.binding)).toThrow('pi_export_asset_undeclared');
      f.assets.splice(index,0,row);f.assets.push(row);expect(()=>verifyPiExportAssets(f.binding)).toThrow('pi_export_asset_undeclared');f.assets.pop();
    }
  });
  it('rejects asset-root drift and an unavailable binding',()=>{
    const f=fixture('interpreter+bundle');
    expect(()=>verifyPiExportAssets({...f.binding,envCommitments:{PI_PACKAGE_DIR:f.root+'-other'}})).toThrow('pi_export_asset_root_mismatch');
    expect(()=>verifyPiExportAssets({...f.binding,identity:{kind:'unavailable',reason:'resolver_unconfigured'}})).toThrow('pi_export_binding_unavailable');
  });
  it('refuses native src-directory redirection without reading an alternate layout',()=>{
    const f=fixture('interpreter+bundle');mkdirSync(path.join(f.root,'src'));
    expect(()=>verifyPiExportAssets(f.binding)).toThrow('pi_export_source_layout_forbidden');
    // Native compiled layout never selects src; the declared compiled root is unchanged.
    const compiled=fixture('compiled-executable');mkdirSync(path.join(compiled.root,'src'));
    expect(()=>verifyPiExportAssets(compiled.binding)).not.toThrow();
  });
});
