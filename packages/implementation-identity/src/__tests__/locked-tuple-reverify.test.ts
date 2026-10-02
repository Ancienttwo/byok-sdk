import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureOfficialExternalCliRecord, realToolImplementationFsProbe, reverifyToolImplementationIdentity, reverifyToolImplementationTuples,
  type ToolImplementationAttestedV1, type ToolImplementationFsProbe } from '../identity';
let dir:string,entry:string,id:ToolImplementationAttestedV1;
const probe:ToolImplementationFsProbe={...realToolImplementationFsProbe,
 async lstat(target){const stat=await realToolImplementationFsProbe.lstat(target);return {...stat,uid:0,mode:stat.mode&~0o222};},
 lstatSync(target){const stat=realToolImplementationFsProbe.lstatSync!(target);return {...stat,uid:0,mode:stat.mode&~0o222};},
};
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
beforeEach(async()=>{
 dir=realpathSync(mkdtempSync(path.join(os.tmpdir(),'byok-locked-tuples-')));const release=path.join(dir,'release');mkdirSync(release);
 entry=path.join(release,'artifact');writeFileSync(entry,'payload-A',{mode:0o555});utimesSync(entry,1700000000,1700000000);
 const asset=path.join(release,'resource');writeFileSync(asset,'resource',{mode:0o444});
 const measured=await measureOfficialExternalCliRecord({kind:'attested',authority:'host-install-record',manifestRevision:'real-tuple-fixture',form:'compiled-executable',
  installPath:entry,closureDigest:hash(entry),closureKind:'artifact',launchArgv:[],launchCwd:dir,assetRoot:release,assets:[{path:'resource',digest:hash(asset)}]}, {}, probe);
 expect(measured.kind).toBe('attested');if(measured.kind!=='attested')throw Error('physical fixture did not measure');id=measured;
});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
it.each(['dev','ino','size','mtimeMs','mode','uid','gid'] as const)('refuses moved %s tuple component',field=>{
 expect(reverifyToolImplementationTuples(id,probe)).toBe('ok');
 const changed:ToolImplementationFsProbe={...probe,lstatSync(target){const stat=probe.lstatSync!(target);return target===entry?{...stat,[field]:stat[field]+1}:stat;}};
 expect(reverifyToolImplementationTuples(id,changed)).toEqual({reason:'install_record_mismatch',subject:'artifact'});
});
it('accepts the same-inode hardlink leaf without binding its realpath spelling',async()=>{
 const alias=path.join(path.dirname(entry),'alias');linkSync(entry,alias);const sameFile={...id,installPath:alias};
 expect(await reverifyToolImplementationIdentity(sameFile,{},probe)).toBe('ok');expect(reverifyToolImplementationTuples(sameFile,probe)).toBe('ok');
});
it('refuses a symlink leaf',()=>{
 renameSync(entry,entry+'.old');symlinkSync(entry+'.old',entry);
 expect(reverifyToolImplementationTuples(id,probe)).toEqual({reason:'install_record_mismatch',subject:'artifact'});
});
it('refuses a substituted parent directory even when the leaf is the recorded inode',()=>{
 const release=path.dirname(entry);renameSync(release,release+'.old');symlinkSync(release+'.old',release);
 expect(reverifyToolImplementationTuples(id,probe)).toEqual({reason:'install_record_mismatch',subject:'artifact'});
});
it('fails closed for an async-only custom probe instead of substituting another ownership view',()=>{
 const asyncOnly:ToolImplementationFsProbe={lstat:probe.lstat,realpath:probe.realpath,digest:probe.digest};
 expect(reverifyToolImplementationTuples(id,asyncOnly)).toEqual({reason:'reverify_failed',subject:'artifact'});
});
it('keeps byte proof separate: equal tuples do not replace the required full hash verification',async()=>{
 chmodSync(entry,0o755);writeFileSync(entry,'payload-B');chmodSync(entry,0o555);utimesSync(entry,1700000000,1700000000);
 expect(reverifyToolImplementationTuples(id,probe)).toBe('ok');
 expect(await reverifyToolImplementationIdentity(id,{},probe)).toEqual({reason:'reverify_failed',subject:'artifact'});
});
