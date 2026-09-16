import { afterEach, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach(home => rmSync(home, {recursive:true,force:true})));

it('loads the real bundled todo library and preserves live non-English translations', () => {
  const root = path.resolve(import.meta.dirname, '../../');
  const entry = pathToFileURL(path.join(root, 'dist/bin/pi-todo-runtime.js')).href;
  const anchor = pathToFileURL(path.join(root, 'dist/assets/extensions/rpiv-todo/2.8.0') + path.sep).href;
  // Both library copies share its documented Symbol.for registry. This public
  // API check therefore exercises translations registered by the shipped bundle.
  const script = `import {createTodoExtension} from ${JSON.stringify(entry)};
    import {applyLocale,scope} from '@juicesharp/rpiv-i18n';
    const factory=createTodoExtension(${JSON.stringify(anchor)});
    const t=scope('@juicesharp/rpiv-todo');
    applyLocale('de'); const de=t('status.pending','pending');
    applyLocale('zh'); const zh=t('status.pending','pending');
    console.log(JSON.stringify({factory:typeof factory,de,zh}));`;
  // The library is TS-only; Bun runs this test driver. The extension under test
  // is already bundled JS; packed Node startup has a separate release smoke.
  const home = mkdtempSync(path.join(tmpdir(), 'todo-i18n-')); homes.push(home);
  const result = spawnSync('bun', ['--eval', script], { cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      ...(process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot} : {}) },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  const actual = JSON.parse(result.stdout);
  for (const locale of ['de', 'zh']) {
    const source = JSON.parse(readFileSync(path.join(root, `dist/assets/extensions/rpiv-todo/2.8.0/locales/${locale}.json`), 'utf8'));
    expect(actual[locale]).toBe(source['status.pending']);
    expect(actual[locale]).not.toBe('pending');
  }
  expect(actual.factory).toBe('function');
});

it('matches upstream Text, truncate and StringEnum through the minified production factory', () => {
  const root = path.resolve(import.meta.dirname, '../../');
  const home = mkdtempSync(path.join(tmpdir(), 'todo-ui-')); homes.push(home);
  const entry = pathToFileURL(path.join(root, 'dist/bin/pi-todo-runtime.js')).href;
  const anchor = pathToFileURL(path.join(root, 'dist/assets/extensions/rpiv-todo/2.8.0') + path.sep).href;
  const script = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {pathToFileURL} from 'node:url';
    import {createTodoExtension} from ${JSON.stringify(entry)};
    import {StringEnum} from '@earendil-works/pi-ai';
    // Explicit native dependency chain is the unchanged upstream oracle;
    // production does not depend on this test-only resolution.
    const nativeRequire=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const {Text,truncateToWidth}=await import(pathToFileURL(nativeRequire.resolve('@earendil-works/pi-tui')).href);
    const handlers=new Map(); let tool; let widget;
    const theme={fg:(_color,text)=>text,bold:text=>text};
    createTodoExtension(${JSON.stringify(anchor)})({
      registerTool(value){tool=value},registerCommand(){},registerShortcut(){},
      on(name,handler){handlers.set(name,handler)}
    });
    assert.deepEqual(tool.parameters.properties.action,StringEnum(['create','update','list','get','delete','clear']));
    const BundledText=tool.renderCall({action:'list'},theme,{}).constructor;
    const samples=['ASCII words','繁體中文測試abc','カタカナ 한글','👩🏽‍💻👨‍👩‍👧‍👦z','e\\u0301 cafe','\\x1b[31m彩色red\\x1b[0m','x\\ty\\nz',''];
    const widths=[0,1,2,4,7,15,60]; let textCases=0,truncateCases=0;
    for(const sample of samples){
      for(const width of widths){
        assert.deepEqual(new BundledText(sample,0,0).render(width),new Text(sample,0,0).render(width));textCases++;
      }
      const ctx={hasUI:true,ui:{theme,getToolsExpanded:()=>true,setWidget(_key,factory){widget=typeof factory==='function'?factory({requestRender(){}},theme):undefined}},
        sessionManager:{getSessionId:()=> 'ui-vector',getBranch:()=>[{type:'message',message:{role:'toolResult',toolName:'todo',details:{tasks:[{id:1,subject:sample,status:'pending'}],nextId:2}}}]}};
      await handlers.get('session_start')({},ctx);
      assert.ok(widget,'real lazy overlay must register');
      const untruncated=widget.render(10000);
      for(const width of widths){
        // Upstream changes the final full tree marker AFTER truncation. At a
        // width which clips its second character, the first glyph stays ├.
        const expected=untruncated.map((line,index)=>{
          const lastTask=index===untruncated.length-2;
          const raw=lastTask?line.replace('└─','├─'):line;
          const clipped=truncateToWidth(raw,width,'…');
          return lastTask?clipped.replace('├─','└─'):clipped;
        });
        assert.deepEqual(widget.render(width),expected);truncateCases++;
      }
    }
    console.log(JSON.stringify({textCases,truncateCases,stringEnum:true}));`;
  const result = spawnSync('bun', ['--eval', script], { cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      ...(process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot} : {}) },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({textCases:56,truncateCases:56,stringEnum:true});
});
