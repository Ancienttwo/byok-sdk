import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { durableToolEnvironment } from '../adapters/pi-durable/environment';
const roots:string[]=[];const cleanups:Array<()=>Promise<void>>=[];const releases:Array<()=>void>=[];
afterEach(async()=>{for(const release of releases.splice(0))release();for(const cleanup of cleanups.splice(0))await cleanup();for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(own:(pid:number)=>Promise<void> = async()=>{}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'byok-durable-shell-')));roots.push(root);const released:number[]=[];
  const env=durableToolEnvironment(root,{...process.env,OPENAI_API_KEY:'PRIVATE_SENTINEL'},{own,released:pid=>released.push(pid)});cleanups.push(()=>env.cleanup(BACKGROUND_CONTEXT));return{root,env,released};
}
// Production durable shell ownership is POSIX-only; Windows admission is explicitly refused.
describe.skipIf(process.platform==='win32')('durable shell ownership and public output behavior',()=>{
  it('holds real bash inert until parent ownership ACK, then runs once without provider env',async()=>{
    let pid:number|undefined;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});releases.push(release);
    const f=await fixture(async observed=>{pid=observed;await gate;});let text='';
    const running=f.env.exec(`printf effect > marker; printf '%s' "$OPENAI_API_KEY"`,{onOutput:chunk=>{text+=chunk;}},BACKGROUND_CONTEXT);
    await vi.waitFor(()=>expect(pid).toBeGreaterThan(1));await expect(fs.lstat(path.join(f.root,'marker'))).rejects.toMatchObject({code:'ENOENT'});
    release();expect(await running).toEqual({ok:true,value:{exitCode:0}});expect(await fs.readFile(path.join(f.root,'marker'),'utf8')).toBe('effect');expect(text).toBe('');expect(f.released).toEqual([pid]);
  });
  it('failed parent ACK disposes the inert shell without a tool side effect',async()=>{
    const f=await fixture(async()=>{throw new Error('lease lost');});const result=await f.env.exec('printf forbidden > marker',undefined,BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('aborted');await expect(fs.lstat(path.join(f.root,'marker'))).rejects.toMatchObject({code:'ENOENT'});expect(f.released).toHaveLength(1);
  });
  it('preserves split UTF8 combined output and the complete public spill file',async()=>{
    const f=await fixture();let output='';const command=`${JSON.stringify(process.execPath)} -e 'process.stdout.write("汉".repeat(70000));process.stderr.write("STDERR_MARKER")'`;
    const result=await f.env.exec(command,{spill:{afterBytes:4096,afterLines:100},onOutput:chunk=>{output+=chunk;}},BACKGROUND_CONTEXT);expect(result.ok).toBe(true);if(!result.ok)throw result.error;
    expect(result.value.exitCode).toBe(0);expect(result.value.spillPath).toBeDefined();roots.push(path.dirname(result.value.spillPath!));
    expect(output.replace('STDERR_MARKER','')).toBe('汉'.repeat(70000));expect(output).not.toContain('\ufffd');expect(await fs.readFile(result.value.spillPath!,'utf8')).toBe(output);expect(f.released).toHaveLength(1);
  });
  it('timeout disposes a real TERM-ignoring shell group and retains typed timeout',async()=>{
    const f=await fixture();const result=await f.env.exec('trap "" TERM; printf ready > timeout-ready; sleep 60', {timeout:0.5}, BACKGROUND_CONTEXT);expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('timeout');expect(await fs.readFile(path.join(f.root,'timeout-ready'),'utf8')).toBe('ready');expect(f.released).toHaveLength(1);
  });
  it('output callback failure returns its typed error after real shell-group disposal',async()=>{
    const f=await fixture();const result=await f.env.exec('while true; do printf tick; sleep 0.05; done',{onOutput:()=>{throw new Error('consumer closed');}},BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('callback_error');expect(f.released).toHaveLength(1);
  });
  it('spills original binary bytes while separately decoding tool text output',async()=>{
    const f=await fixture();const expected=Buffer.from(Array.from({length:8192},(_,i)=>i%256));
    const command=`${JSON.stringify(process.execPath)} -e 'process.stdout.write(Buffer.from(Array.from({length:8192},(_,i)=>i%256)))'`;
    const result=await f.env.exec(command,{spill:{afterBytes:4096,afterLines:100}},BACKGROUND_CONTEXT);expect(result.ok).toBe(true);if(!result.ok)throw result.error;
    expect(result.value.spillPath).toBeDefined();roots.push(path.dirname(result.value.spillPath!));expect(await fs.readFile(result.value.spillPath!)).toEqual(expected);expect(f.released).toHaveLength(1);
  });
  it('real spill I/O failure returns after group disposal rather than hanging on finish',async()=>{
    const f=await fixture();const create=f.env.createTempFile.bind(f.env);
    f.env.createTempFile=async(options,context)=>{const file=await create(options,context);if(file.ok){roots.push(path.dirname(file.value));await fs.unlink(file.value);await fs.mkdir(file.value);}return file;};
    const result=await f.env.exec(`${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(8192))'`,{spill:{afterBytes:4096,afterLines:100}},BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);if(!result.ok)expect(result.error.code).toBe('unknown');expect(f.released).toHaveLength(1);
  });
});
