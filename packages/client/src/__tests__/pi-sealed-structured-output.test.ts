import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const buildRequire = createRequire(createRequire(import.meta.url).resolve('tsup'));
const {build} = buildRequire('esbuild') as {build(options: unknown): Promise<unknown>};
const client = path.resolve(import.meta.dirname, '../..');
const vendor = path.join(client, 'vendor/pi-subagents/0.60.0');
const scratch = mkdtempSync(path.join(client, 'node_modules/.byok-alpha-'));
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const refusal = 'sealed_structured_output_unsupported';

// Exercise existing upstream execution/admission functions, with the same build
// flavor seam as the private host. No mock replacement of those functions.
beforeAll(async () => {
  const exports = [
    ['src/agents/agent-refinements.ts', ['handleRefinementAction']],
    ['src/runs/shared/chain-outputs.ts', ['validateChainOutputBindings']],
    ['src/runs/shared/dynamic-fanout.ts', ['validateDynamicStepShape']],
    ['src/runs/foreground/subagent-executor.ts', ['prepareWorkflowLaunchParams']],
    ['src/slash/delegation-adapters.ts', ['toSubagentDelegationExecutionParams']],
    ['src/runs/shared/structured-output.ts', ['createStructuredOutputRuntime', 'validateStructuredOutputValue', 'readStructuredOutput']],
  ] as const;
  for (const sealed of [false, true]) {
    await build({ stdin: { contents: exports.map(([file, names]) => `export {${names.join(',')}} from ${JSON.stringify(path.join(vendor, file))};`).join('\n'), resolveDir: client, loader: 'ts' },
      bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'es2022',
      outfile: path.join(scratch, sealed ? 'sealed.mjs' : 'ordinary.mjs'),
      plugins: [{ name: 'frozen-original-dependencies', setup(builder: {resolve(specifier: string, options: unknown): Promise<{path: string; errors: unknown[]}>; onResolve(options: {filter: RegExp}, callback: (args: {path: string; pluginData?: unknown}) => unknown): void}) {
        builder.onResolve({filter: /^@earendil-works\/(pi-agent-core|pi-tui)$/}, args => {
          const peerRoot = realpathSync(path.join(realpathSync(path.join(client,'node_modules/pi-subagents')), '..', args.path));
          const manifest = JSON.parse(readFileSync(path.join(peerRoot, 'package.json'), 'utf8'));
          const entry = args.path.endsWith('/pi-agent-core') ? manifest.exports['.'].import : manifest.main;
          expect(manifest.type).toBe('module');
          expect(typeof entry).toBe('string');
          const resolved = path.resolve(peerRoot, entry);
          expect(resolved.startsWith(peerRoot + path.sep)).toBe(true);
          return {path: resolved, external: true};
        });
        builder.onResolve({ filter: /structured-output\.ts$/ }, args => sealed ? { path: path.join(vendor, 'src/runs/shared/structured-output-sealed.ts') } : undefined);
      } }],
    });
  }
});
afterAll(() => rmSync(scratch, {recursive: true, force: true}));

function probe(expression: string, sealed = true) {
  const script = `import * as api from ${JSON.stringify(path.join(scratch, sealed ? 'sealed.mjs' : 'ordinary.mjs'))};
    const schema=${JSON.stringify(schema)};
    try {const value=await (${expression});console.log(JSON.stringify({ok:true,value}));}
    catch(error){console.log(JSON.stringify({ok:false,message:String(error)}));}`;
  const result = spawnSync('bun', ['--no-install', '--eval', script], {cwd: client, encoding: 'utf8', env: {...process.env, HOME:path.join(scratch,'home'), PI_CODING_AGENT_DIR:path.join(scratch,'home/.pi/agent'), PI_SUBAGENT_CHILD:'1'}});
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim());
}

const cases = [
  ['chain', `api.validateChainOutputBindings([{agent:'one',outputSchema:schema}])`, `api.validateChainOutputBindings([{agent:'one'}])`],
  ['static parallel', `api.validateChainOutputBindings([{parallel:[{agent:'one'},{agent:'two',outputSchema:schema}]}])`, `api.validateChainOutputBindings([{parallel:[{agent:'one'},{agent:'two'}]}])`],
  ['dynamic collect', `api.validateDynamicStepShape({expand:{from:{output:'items',path:''},maxItems:2},parallel:{agent:'one'},collect:{as:'collected',outputSchema:schema}},0)`, `api.validateDynamicStepShape({expand:{from:{output:'items',path:''},maxItems:2},parallel:{agent:'one'},collect:{as:'collected'}},0)`],
  ['workflow inherited schema', `api.prepareWorkflowLaunchParams({outputSchema:schema},{agent:'one',task:'text'},'parent','child')`, `api.prepareWorkflowLaunchParams({},{agent:'one',task:'text'},'parent','child')`],
  ['workflow retained resume', `api.prepareWorkflowLaunchParams({outputSchema:schema},{resume:'prior',task:'continue'},'parent','child')`, `api.prepareWorkflowLaunchParams({},{resume:'prior',task:'continue'},'parent','child')`],
  ['slash delegation', `api.toSubagentDelegationExecutionParams({agent:'one',task:'text',result:{kind:'structured',schema}})`, `api.toSubagentDelegationExecutionParams({agent:'one',task:'text',result:{kind:'text'}})`],
] as const;

describe('sealed user-schema admission', () => {
  it.each(cases)('%s refuses explicitly', (_name, structured) => {
    expect(probe(structured)).toMatchObject({ok:false,message:expect.stringContaining(refusal)});
  });
  it.each(cases)('%s retains its plain-text control', (_name, _structured, text) => {
    expect(probe(text)).toMatchObject({ok:true});
  });
  it.each(cases)('%s retains ordinary structured output', (_name, structured) => {
    expect(probe(structured, false)).toMatchObject({ok:true});
  });
  it('refinement rejects before calling the proposal child', () => {
    const cwd=path.join(scratch,'refinement');
    mkdirSync(path.join(cwd,'.agents'),{recursive:true});
    writeFileSync(path.join(cwd,'.agents/one.md'),'---\nname: one\ndescription: Test agent\n---\nText instructions.\n');
    const expression=`(async()=>{let launches=0;const ctx={cwd:${JSON.stringify(cwd)},state:{asyncJobs:new Map([['job',{asyncId:'job',agents:['one'],cwd:${JSON.stringify(cwd)},asyncDir:'unused',status:'completed',updatedAt:Date.now()}]])},signal:new AbortController().signal,launchProposalChild:async()=>{launches++;return {isError:true};}};
      let result;try{result=await api.handleRefinementAction('refine',{agent:'one'},ctx);}catch(error){result={isError:true,content:[{type:'text',text:String(error)}]};}return {launches,result};})()`;
    expect(probe(expression)).toMatchObject({ok:true,value:{launches:0,result:{isError:true,content:[{type:'text',text:expect.stringContaining(refusal)}]}}});
    expect(probe(expression,false)).toMatchObject({ok:true,value:{launches:1}});
  });
  it('refuses structured runtime creation before creating its artifact directory', () => {
    const dir = path.join(scratch, 'must-not-create');
    expect(probe(`api.createStructuredOutputRuntime(schema,${JSON.stringify(dir)})`)).toMatchObject({ok:false,message:expect.stringContaining(refusal)});
    expect(existsSync(dir)).toBe(false);
  });
  it('refuses recovery validation rather than returning an unchecked value', () => {
    const output = path.join(scratch, 'recovered.json'); writeFileSync(output, JSON.stringify({answer:'recorded'}));
    expect(probe(`api.readStructuredOutput({schema,schemaPath:'unused',outputPath:${JSON.stringify(output)}})`)).toMatchObject({ok:false,message:expect.stringContaining(refusal)});
    expect(probe(`api.readStructuredOutput({schema,schemaPath:'unused',outputPath:${JSON.stringify(output)}})`, false)).toMatchObject({ok:true,value:{value:{answer:'recorded'}}});
  });
});
