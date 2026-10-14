import { promises as fs } from 'node:fs';
import type { ExecutionScratch } from '../../daemon/retention/scratch';
import { RuntimeDisposalFailure } from '../../runtime-failure';
/** Process-ownership unit tests inject an inert resource port; real retention tests own filesystem coverage. */
export function inertScratch(sdkDir?: string): ExecutionScratch {
 let released=false;
 return { token: '000000000000', sdkDir: sdkDir ?? '/inert-config', runtimeDir:'/inert-runtime', env:{TMPDIR:'/inert-runtime',TEMP:'/inert-runtime',TMP:'/inert-runtime'},
  release: async()=>{if(released)return;try {if(sdkDir!==undefined)await fs.rm(sdkDir,{recursive:true,force:true});released=true;}catch(cause){throw new RuntimeDisposalFailure({stage:'cleanup',reason:'fixture scratch cleanup failed'},{cause});}} };
}
