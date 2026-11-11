import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderStatus } from '@byok-sdk/keys';
import { applyModelRouteChange, createModelRouteDraft, modelRouteContext, type ModelRouteChange } from '@byok-sdk/keys/model-route';
import { describe, expect, it, vi } from 'vitest';
import type { CustodyRequest } from '../../custody/protocol.ts';
import { Receipt } from './keys-section.tsx';
import { submitModelRoute } from './submit.ts';

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
    const submit = vi.fn(async (request: CustodyRequest) => {
      expect(request).toMatchObject({ op: 'configure', secret: 'test-provider-key', configuration: { profile_ref: 'zai-main', model: 'glm-4.7' } });
      return { profile_ref: 'zai-main', display_name: 'GLM main', provider_kind: 'zai', model: 'glm-4.7', secret_configured: true, profile_revision: 'r1' } as ProviderStatus;
    });
    const result = await submitModelRoute(draft, context, submit);
    expect(submit).toHaveBeenCalledOnce();
    expect(result.draft.secret).toBe('none');
    if (!('receipt' in result.outcome)) throw new Error(result.outcome.error);
    const html = renderToStaticMarkup(createElement(Receipt, { status: result.outcome.receipt }));
    expect(html).toContain('Saved GLM main');
    expect(html).not.toContain('test-provider-key');
  });

  it('shows a refusal as reported, clears the key and does not resubmit', async () => {
    const submit = vi.fn(async () => { throw new Error('Keys catalog refused: profile zai-main collides'); });
    const result = await submitModelRoute(draft, context, submit);
    expect(submit).toHaveBeenCalledOnce();
    expect(result.outcome).toEqual({ error: 'Keys catalog refused: profile zai-main collides' });
    expect(result.draft.secret).toBe('none');
    expect(result.draft.profile_ref).toBe('zai-main');
  });
});
