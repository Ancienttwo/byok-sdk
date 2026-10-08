import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import layout from '../adapters/pi/pi-export-asset-layout.json';
import source from '../adapters/pi/pi-export-assets.source.json';

const nativeRoot = path.resolve(import.meta.dirname,'../../node_modules/@earendil-works/pi-coding-agent');
const roots: string[] = [];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
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
    for(const file of ['pi-export-asset-layout.json','pi-export-assets.source.json'])cpSync(path.resolve(import.meta.dirname,'../adapters/pi',file),path.join(sourceDir,file));
    const script=path.join(scriptDir,'build-pi-export-assets.mjs');
    cpSync(path.resolve(import.meta.dirname,'../../scripts/build-pi-export-assets.mjs'),script);
    writeFileSync(path.join(root,'package.json'),JSON.stringify({byok:{piRuntimePin:source.packageVersion}}));
    const pinRoot=path.join(root,'node_modules/@earendil-works/pi-coding-agent');
    mkdirSync(path.dirname(pinRoot),{recursive:true});cpSync(realpathSync(nativeRoot),pinRoot,{recursive:true});
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
    const failed=run();expect(failed.status).not.toBe(0);expect(failed.stderr).toMatch(/export resource digest drift/);
  });
});
