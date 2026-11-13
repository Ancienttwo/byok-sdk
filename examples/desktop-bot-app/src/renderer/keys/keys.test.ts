import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderStatus } from '@byok-sdk/keys';
import { applyModelRouteChange, createModelRouteDraft, modelRouteContext, modelRouteSubmission, type ModelRouteChange } from '@byok-sdk/keys/model-route';
import { describe, expect, it, vi } from 'vitest';
import type { CustodyChange } from '../../custody/protocol.ts';
import { BridgeCallError } from '../bridge.ts';
import { Receipt } from './keys-section.tsx';
import { runLocked, storedProfile, submitModelRoute, submitReplaceSecret } from './submit.ts';

const context = modelRouteContext();
const changes: ModelRouteChange[] = [
  { field: 'profile_ref', value: 'zai-main' },
  { field: 'display_name', value: 'GLM main' },
  { field: 'provider_kind', value: 'zai' },
  { field: 'model', value: 'glm-4.7' },
  { field: 'secret', value: { replace: 'test-provider-key' } },
];
const draft = changes.reduce((current, change) => applyModelRouteChange(current, change, context), createModelRouteDraft(context));

describe('keys form submission', () => {
  it('sends the key once to keys.submit, clears it and shows the receipt', async () => {
    const submit = vi.fn(async (request: CustodyChange) => {
      expect(request).toMatchObject({ op: 'configure', secret: 'test-provider-key', configuration: { profile_ref: 'zai-main', model: 'glm-4.7' } });
      return { profile_ref: 'zai-main', display_name: 'GLM main', provider_kind: 'zai', model: 'glm-4.7', secret_configured: true, profile_revision: 'r1' } as ProviderStatus;
    });
    let cleared = draft;
    const result = await submitModelRoute(draft, context, null, submit, next => { cleared = next; });
    expect(submit).toHaveBeenCalledOnce();
    expect(cleared.secret).toBe('none');
    if (!('receipt' in result)) throw new Error(result.refusal.message);
    const html = renderToStaticMarkup(createElement(Receipt, { status: result.receipt }));
    expect(html).toContain('Saved GLM main');
    expect(html).not.toContain('test-provider-key');
  });

  it('shows a refusal by its code and message, clears the key and does not resubmit', async () => {
    const submit = vi.fn(async () => { throw new BridgeCallError('method_failed', 'Keys catalog refused: profile zai-main collides'); });
    let cleared = draft;
    const result = await submitModelRoute(draft, context, null, submit, next => { cleared = next; });
    expect(submit).toHaveBeenCalledOnce();
    expect(result).toEqual({ refusal: { code: 'method_failed', message: 'Keys catalog refused: profile zai-main collides' } });
    expect(cleared.secret).toBe('none');
    expect(cleared.profile_ref).toBe('zai-main');
  });

  it('edits a listed profile without sending its kept key or changing the default', async () => {
    const created = modelRouteSubmission(draft, context);
    if (!created.ok) throw new Error('the fixture draft is valid');
    const listed = { ...created.profile, enabled: false, secret_configured: true, configuration_pending: false } as unknown as ProviderStatus;
    expect(storedProfile({ ...listed, configuration_pending: true }).secret_configured).toBe(false);
    const editContext = modelRouteContext({ stored: storedProfile(listed) });
    const edit = applyModelRouteChange(createModelRouteDraft(editContext), { field: 'display_name', value: 'GLM renamed' }, editContext);
    expect(edit.secret).toBe('keep');
    const submit = vi.fn(async (_change: CustodyChange) => ({ ...listed, display_name: 'GLM renamed', profile_revision: 'r2' }) as ProviderStatus);
    let cleared = edit;
    await submitModelRoute(edit, editContext, listed, submit, next => { cleared = next; });
    expect(cleared.secret).toBe('keep');
    const change = submit.mock.calls[0]![0];
    expect(change).toMatchObject({ op: 'configure', configuration: { profile_ref: 'zai-main', display_name: 'GLM renamed', enabled: false } });
    expect(change).not.toHaveProperty('secret');
  });

  it('clears the draft before a deferred bridge call and unlocks after its refusal', async () => {
    let cleared = draft;
    let refuse!: (error: Error) => void;
    const pending = new Promise<ProviderStatus>((_resolve, reject) => { refuse = reject; });
    const submit = vi.fn(() => { expect(cleared.secret).toBe('none'); return pending; });
    const setBusy = vi.fn();
    const onOutcome = vi.fn();
    const running = runLocked(setBusy,
      () => submitModelRoute(draft, context, null, submit, next => { cleared = next; }), onOutcome, vi.fn());
    expect(submit).toHaveBeenCalledOnce();
    expect(cleared.secret).toBe('none');
    expect(setBusy.mock.calls).toEqual([[true]]);
    refuse(new BridgeCallError('custody_timeout', 'Reload stored providers'));
    await running;
    expect(onOutcome).toHaveBeenCalledWith({ refusal: { code: 'custody_timeout', message: 'Reload stored providers' } });
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
    expect(cleared.secret).toBe('none');
  });

  it('replaces a stored key through keys.submit and shows only the receipt', async () => {
    const submit = vi.fn(async (_change: CustodyChange) => ({ profile_ref: 'zai-main', secret_configured: true }) as ProviderStatus);
    const outcome = await submitReplaceSecret('zai-main', 'new-provider-key', submit);
    expect(submit).toHaveBeenCalledWith({ op: 'replace_secret', profileRef: 'zai-main', secret: 'new-provider-key' });
    expect(outcome).toEqual({ receipt: { profile_ref: 'zai-main', secret_configured: true } });
  });

  it('holds the section lock through the reload after a receipt and releases it after a refusal or a thrown error', async () => {
    const receipt = { receipt: { profile_ref: 'a' } as ProviderStatus };
    const trace: string[] = [];
    const setBusy = (busy: boolean) => trace.push(`busy:${busy}`);
    const reload = async () => { trace.push('reload'); };
    await runLocked(setBusy, async () => receipt, () => trace.push('outcome'), reload);
    expect(trace).toEqual(['busy:true', 'outcome', 'reload', 'busy:false']);
    trace.length = 0;
    await runLocked(setBusy, async () => ({ refusal: { message: 'no' } }), () => trace.push('outcome'), reload);
    expect(trace).toEqual(['busy:true', 'outcome', 'busy:false']);
    trace.length = 0;
    await expect(runLocked(setBusy, async () => { throw new Error('bridge'); }, () => trace.push('outcome'), reload)).rejects.toThrow('bridge');
    expect(trace).toEqual(['busy:true', 'busy:false']);
  });
});
