// Usage: node prepare.mjs OLD_PACK_DIR NEW_PACK_DIR INSTALL_ROOT
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [oldPack,newPack,output]=process.argv.slice(2).map(x=>resolve(x));
const subjects=[];
for(const [lane,pack,sha] of [['old',oldPack,'2752ffe86c4b222e2a23e75176dd2dd3a75901bb'],['new',newPack,'6bcf659874be14ed27378d6dcb635a8a9a23a258']]){
 const manifestBytes=readFileSync(pack+'/release-manifest.json');const manifest=JSON.parse(manifestBytes);assert.equal(manifest.sourceGitSha,sha);
 const dependencies={};for(const p of manifest.packages){assert.equal(createHash('sha256').update(readFileSync(pack+'/'+p.file)).digest('hex'),p.sha256);dependencies[p.package]='file:'+pack+'/'+p.file;}
 dependencies['@hono/node-server']='1.19.11';const dir=output+'/'+lane;mkdirSync(dir,{recursive:true});
 writeFileSync(dir+'/package.json',JSON.stringify({private:true,type:'module',dependencies,overrides:Object.fromEntries(manifest.packages.map(p=>[p.package,'$'+p.package]))},null,2));
 const result=spawnSync('npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:dir,stdio:'inherit'});assert.equal(result.status,0);
 writeFileSync(dir+'/bridge.mjs',"export * from '@byok-sdk/client';\nexport * from '@byok-sdk/cloud';\nexport {serve} from '@hono/node-server';\n");
 const lock=JSON.parse(readFileSync(dir+'/package-lock.json'));
 for(const p of manifest.packages){const installed=lock.packages['node_modules/'+p.package];assert.equal(installed.version,p.version);assert.equal(installed.integrity,p.sha512Integrity);}
 subjects.push({lane,source:sha,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),packages:manifest.packages,lockSha256:createHash('sha256').update(readFileSync(dir+'/package-lock.json')).digest('hex')});
}
writeFileSync(dirname(fileURLToPath(import.meta.url))+'/subjects.json',JSON.stringify({node:process.version,subjects},null,2)+'\n');
