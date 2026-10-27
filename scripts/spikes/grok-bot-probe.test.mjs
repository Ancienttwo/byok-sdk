import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, extractDeepLinkRoutes, listAsarFiles, parseFuses, promptLinkOutcomes, readAsarHeader } from './grok-bot-probe.mjs';

function asar(tree) {
  const json = Buffer.from(JSON.stringify(tree));
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(json.length + 8, 4);
  head.writeUInt32LE(json.length + 4, 8);
  head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, json]);
}

const quiet = { acpMarkers: [], tcpListeners: [], devControlServer: 'unpackaged-only', promptLink: { submits: false } };

describe('grok-bot-probe', () => {
  it('reads an asar header and lists nested files', () => {
    const buf = asar({ files: { dist: { files: { 'a.cjs': { size: 3, offset: '0' }, n: { files: { 'b.node': { size: 1, offset: '3', unpacked: true } } } } } } });
    const { tree, dataOffset } = readAsarHeader((pos, len) => buf.subarray(pos, pos + len));
    assert.equal(dataOffset, 8 + buf.readUInt32LE(4));
    assert.deepEqual(listAsarFiles(tree).map(f => [f.path, f.unpacked]), [['/dist/a.cjs', false], ['/dist/n/b.node', true]]);
  });

  it('parses Electron fuses after the sentinel', () => {
    const buf = Buffer.concat([Buffer.from('xx'), Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 2, 0x30, 0x31])]);
    assert.deepEqual(parseFuses(buf), { wireVersion: 1, fuses: { RunAsNode: 'off', EnableCookieEncryption: 'on' } });
    assert.equal(parseFuses(Buffer.from('none')), null);
  });

  it('extracts the deep-link route table', () => {
    const src = 'routes:{agent:Ye("/v1/agent",{id:K(Tu)}),prompt:Ye("/v1/prompt",{id:Te(K(Tu)),text:K({a:1})}),"create-team-bot":Ye("/v1/create-team-bot",{})}';
    assert.deepEqual(extractDeepLinkRoutes(src), { agent: '/v1/agent', prompt: '/v1/prompt', 'create-team-bot': '/v1/create-team-bot' });
  });

  it('reads the prompt handler outcomes and whether it submits', () => {
    const prefill = 'async function uin(e,t){if(r==null)return tl(`[sand] deep-link: rejected reason=no-main-agent`),`no-main-agent`;t.drafts.setDraft(a,{prompt:e.text});return`prefilled`}function din(){}';
    assert.deepEqual(promptLinkOutcomes(prefill), { outcomes: ['no-main-agent', 'prefilled'], setsDraft: true, submits: false });
    const send = prefill.replace('t.drafts.setDraft(', 't.composer.sendMessage(');
    assert.equal(promptLinkOutcomes(send).submits, true);
    assert.equal(promptLinkOutcomes('no handler'), null);
  });

  it('fails closed when no surface can submit, and asks for review otherwise', () => {
    assert.equal(decide(quiet), 'fail-closed');
    assert.equal(decide({ ...quiet, tcpListeners: [{ pid: 1, line: 'x' }] }), 'needs-review');
    assert.equal(decide({ ...quiet, acpMarkers: [{ file: 'f', marker: '"session/prompt"' }] }), 'needs-review');
    assert.equal(decide({ ...quiet, promptLink: { submits: true } }), 'needs-review');
  });
});
