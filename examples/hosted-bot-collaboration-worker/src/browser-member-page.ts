/// <reference lib="dom" />
import { BrowserMember, MemberFailure, memberTransport, type BrowserTaskTemplate } from './browser-member';
import { parseMemberKeyBundle, type MemberKeyBundleV1 } from '@byok-sdk/core/sealed-payload';
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const output = (id: string, text: string) => { document.getElementById(id)!.textContent = text; };
let member: BrowserMember | undefined;
async function otherBundle(): Promise<MemberKeyBundleV1> {
  try {
    const bundle = await parseMemberKeyBundle(JSON.parse(input('other-bundle').value));
    if (!bundle) throw new MemberFailure('public_bundle_invalid');
    return bundle;
  } catch { throw new MemberFailure('public_bundle_invalid'); }
}
function current(): BrowserMember { if (!member) throw new MemberFailure('create_keys_first'); return member; }
function report(value: Record<string, unknown>) {
  const text = JSON.stringify({ ...value, browser: navigator.userAgent });
  output('result', text);
  console.info(text);
}
function action(id: string, run: () => Promise<void>) {
  input(id).addEventListener('click', async () => {
    // Serialize operations so chain writes and pairing confirmations cannot race in one tab.
    const enabled = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled);
    enabled.forEach(button => { button.disabled = true; });
    try { await run(); }
    catch (error) { report({ result: 'FAIL', reason: error instanceof MemberFailure ? error.message : 'operation_failed',
      ...(error instanceof MemberFailure && error.scopeKey ? { scopeKey: error.scopeKey } : {}) }); }
    finally { enabled.forEach(button => { button.disabled = false; }); }
  });
}
action('create', async () => {
  const bearer = input('bearer').value;
  input('bearer').value = '';
  if (!bearer || !input('tenant').value) throw new MemberFailure('bearer_and_tenant_required');
  member = await BrowserMember.create(input('tenant').value, memberTransport(bearer));
  input('bundle').value = JSON.stringify(member.member);
  input('remove-member').value = member.member.memberId;
  for (const id of ['copy-bundle', 'start', 'verify', 'compare', 'join', 'scope-button', 'submit', 'decrypt', 'revoke']) input(id).disabled = false;
  report({ result: 'KEYS_READY', memberId: member.member.memberId });
});
action('copy-bundle', async () => { await navigator.clipboard.writeText(JSON.stringify(current().member)); });
action('start', async () => { output('pairing', await current().start(input('product').value)); });
action('verify', async () => {
  input('confirm-device').disabled = true;
  input('device-compared').checked = false;
  output('device-code', '');
  output('device-code', await current().verifyDevice(input('device').value));
  input('confirm-device').disabled = false;
});
action('confirm-device', async () => {
  if (!input('device-compared').checked) throw new MemberFailure('compare_code_first');
  await current().confirmDevice();
  output('pairing', '');
  report({ result: 'PAIR_PASS', chainLength: current().chainLength });
});
action('compare', async () => {
  input('approve').disabled = true;
  input('browser-compared').checked = false;
  output('browser-code', '');
  output('browser-code', await current().compareBrowser(await otherBundle()));
  input('approve').disabled = false;
});
action('approve', async () => {
  if (!input('browser-compared').checked) throw new MemberFailure('compare_code_first');
  await current().confirmBrowser();
  report({ result: 'ADD_PASS', chainLength: current().chainLength });
});
action('join', async () => {
  if (!input('browser-compared').checked) throw new MemberFailure('compare_code_first');
  await current().join(await otherBundle());
  report({ result: 'JOIN_PASS', chainLength: current().chainLength });
});
action('scope-button', async () => {
  await current().scope(input('scope').value, Number(input('epoch').value));
  report({ result: 'SCOPE_READY', chainLength: current().chainLength });
});
action('submit', async () => {
  let template: BrowserTaskTemplate;
  try { template = JSON.parse(input('template').value) as BrowserTaskTemplate; }
  catch { throw new MemberFailure('routing_template_json_invalid'); }
  const submitted = await current().submit(template, input('scope').value, Number(input('epoch').value));
  input('task').value = submitted.taskId;
  input('hash').value = submitted.sha256;
  report({ result: 'SUBMITTED', ...submitted });
});
action('decrypt', async () => { report(await current().decrypt(input('task').value, input('hash').value)); });
action('revoke', async () => {
  await current().revoke(input('remove-member').value);
  report({ result: 'REMOVED', chainLength: current().chainLength });
});
