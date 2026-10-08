import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractPiConfigDigest, readPiHostConfig, serializePiHostConfig } from '../adapters/pi/runtime-host-binding';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive:true,force:true})));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pi-host-config-'))); roots.push(root);
  const configPath = path.join(root,'config.json');
  const config = {format:'fixture',cwd:path.join(root,'session'),mcp:{mcpServers:{}}};
  const serialized = serializePiHostConfig(config); await fs.writeFile(configPath,serialized.bytes);
  return {config,configPath,serialized};
}

const digestCases = (JSON.parse(readFileSync(new URL('../../../../tests/fixtures/c07-runtime-record/rejections.v1.json', import.meta.url), 'utf8')).compositionCases as { id:string; argvCases?: {id:string;argv:string[];expectedReason:string}[] }[])
  .filter(test => test.argvCases !== undefined);

describe('Pi child launch config digest', () => {
  it.each(digestCases)('executes frozen digest refusal family $id', family => {
    for (const test of family.argvCases!) expect(() => extractPiConfigDigest(test.argv)).toThrow(test.expectedReason);
  });

  it.each([[], ['--config-digest'], ['--config-digest=x'], [`--config-digest=${'A'.repeat(64)}`],
    [`--config-digest=${'a'.repeat(64)}`,`--config-digest=${'a'.repeat(64)}`]].map(argv=>({argv})))('rejects missing, malformed or duplicate owned digest %#', ({argv}) => {
    expect(()=>extractPiConfigDigest(argv)).toThrow(/config-digest/);
  });

  it('reads the exact config bytes the digest names', async () => {
    const f = await fixture();
    expect(extractPiConfigDigest([`--config-digest=${f.serialized.digest}`,'--config',f.configPath]))
      .toEqual({digest:f.serialized.digest,args:['--config',f.configPath]});
    expect(readPiHostConfig(f.configPath,f.serialized.digest)).toEqual(f.config);
  });

  it('rejects changed complete config bytes', async () => {
    const f = await fixture();
    await fs.writeFile(f.configPath,JSON.stringify({...f.config,cwd:f.config.cwd+'x'}));
    expect(()=>readPiHostConfig(f.configPath,f.serialized.digest)).toThrow(/config byte digest mismatch/);
  });
});
