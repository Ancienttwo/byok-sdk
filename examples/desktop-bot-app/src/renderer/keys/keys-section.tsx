import { useMemo, useState } from 'react';
import type { ProviderStatus } from '@byok-sdk/keys';
import {
  applyModelRouteChange, createModelRouteDraft, modelRouteContext, modelRouteView,
  type ModelRouteChange, type ModelRouteErrorCode, type ModelRouteFieldView, type ModelRouteModelChoice, type ModelRouteDraft,
  type ModelRouteContext, type PiModelApi,
} from '@byok-sdk/keys/model-route';
import { useConversation } from '../conversation/use-conversation.ts';
import './keys.css';
import { submitModelRoute, type SubmitOutcome } from './submit.ts';

const ERROR_COPY: Readonly<Record<ModelRouteErrorCode, string>> = {
  required: 'Required.',
  invalid_value: 'This value is not valid.',
  invalid_url: 'Enter a valid https URL.',
  not_a_choice: 'Pick one of the listed values.',
  adapter_auth_mismatch: 'This adapter does not accept that auth mode.',
  vendor_adapter_mismatch: 'This provider does not use that adapter.',
  pi_model_required: 'This model needs a Pi model config.',
  pi_model_invalid: 'The Pi model config is not valid.',
  thinking_level_unsupported: 'This model does not support that thinking level.',
  secret_required: 'Enter the API key.',
  secret_reentry_required: 'Enter the API key again: the stored key does not fit the changed endpoint.',
  secret_invalid: 'The API key is not valid.',
};

const LABELS: Readonly<Record<ModelRouteFieldView['field'], string>> = {
  profile_ref: 'Profile id', display_name: 'Name', provider_kind: 'Provider', adapter: 'Adapter', auth_mode: 'Auth mode',
  base_url: 'Base URL', model: 'Model', pi_model: 'Pi model config (JSON)', thinking_level: 'Thinking level',
  capabilities: 'Capabilities', secret: 'API key',
};

type Change = (change: ModelRouteChange) => void;

function FieldError({ view }: { view: ModelRouteFieldView }) {
  if (view.error === null) return null;
  const paths = view.error.paths?.length ? ` (${view.error.paths.join(', ')})` : '';
  return <span className="keys-field-error">{ERROR_COPY[view.error.code]}{paths}</span>;
}

/** A select over the view's choices; the empty option is `null`, the value of a field nobody has picked. */
function ChoiceInput({ view, onPick }: { view: ModelRouteFieldView; onPick: (value: string | null) => void }) {
  return (
    <select value={typeof view.value === 'string' ? view.value : ''} onChange={event => onPick(event.target.value === '' ? null : event.target.value)}>
      <option value="">—</option>
      {view.choices!.map(choice => <option key={choice.value} value={choice.value}>{choice.label ?? choice.value}</option>)}
    </select>
  );
}

/** The model id is free text; a catalog or Host entry is picked from the list, which also fixes its Pi api. */
function ModelInput({ view, draft, onChange }: { view: ModelRouteFieldView; draft: ModelRouteDraft; onChange: Change }) {
  const choices = (view.choices ?? []) as readonly ModelRouteModelChoice[];
  const key = (value: string, api: PiModelApi) => `${api} ${value}`;
  const picked = choices.find(choice => choice.value === draft.model && choice.api === draft.model_api);
  return (
    <>
      {choices.length > 0 && (
        <select value={picked ? key(picked.value, picked.api) : ''} onChange={event => {
          const choice = choices.find(entry => key(entry.value, entry.api) === event.target.value);
          if (choice) onChange({ field: 'model', value: choice.value, api: choice.api });
        }}>
          <option value="">Other model…</option>
          {choices.map(choice => (
            <option key={key(choice.value, choice.api)} value={key(choice.value, choice.api)} disabled={choice.status !== 'representable'}>
              {choice.label ?? choice.value} ({choice.api})
            </option>
          ))}
        </select>
      )}
      <input value={draft.model} onChange={event => onChange({ field: 'model', value: event.target.value })} />
    </>
  );
}

/** Keeps the typed text; text that is not JSON goes to the draft as typed, and the draft's own check refuses it. */
function PiModelInput({ draft, onChange }: { draft: ModelRouteDraft; onChange: Change }) {
  const [text, setText] = useState(() => (draft.pi_model === null || draft.pi_model === undefined ? '' : JSON.stringify(draft.pi_model, null, 2)));
  return (
    <textarea rows={6} value={text} onChange={event => {
      setText(event.target.value);
      let value: unknown = event.target.value;
      try { value = JSON.parse(event.target.value); } catch { /* the draft reports pi_model_invalid */ }
      onChange({ field: 'pi_model', value });
    }} />
  );
}

function FieldInput({ view, draft, onChange }: { view: ModelRouteFieldView; draft: ModelRouteDraft; onChange: Change }) {
  switch (view.field) {
    case 'profile_ref':
    case 'display_name':
    case 'base_url':
      return <input value={draft[view.field]} onChange={event => onChange({ field: view.field as 'profile_ref', value: event.target.value })} />;
    case 'provider_kind':
    case 'adapter':
    case 'auth_mode':
    case 'thinking_level':
      return <ChoiceInput view={view} onPick={value => onChange({ field: view.field, value } as ModelRouteChange)} />;
    case 'model':
      return <ModelInput view={view} draft={draft} onChange={onChange} />;
    case 'pi_model':
      return <PiModelInput draft={draft} onChange={onChange} />;
    case 'capabilities':
      return (
        <span className="keys-checks">
          {view.choices!.map(({ value }) => (
            <label key={value}>
              <input type="checkbox" checked={draft.capabilities.includes(value as never)} onChange={event => onChange({
                field: 'capabilities',
                value: (event.target.checked ? [...draft.capabilities, value] : draft.capabilities.filter(entry => entry !== value)) as ModelRouteDraft['capabilities'],
              })} />
              {value}
            </label>
          ))}
        </span>
      );
    case 'secret': {
      // The key lives only in this input and the draft; an empty input sends no key.
      const typed = typeof draft.secret === 'object' ? draft.secret.replace : '';
      return <input type="password" autoComplete="off" value={typed}
        onChange={event => onChange({ field: 'secret', value: event.target.value === '' ? 'none' : { replace: event.target.value } })} />;
    }
  }
}

/** The custody receipt: the registry's secret-free status of the profile it wrote. */
export function Receipt({ status }: { status: ProviderStatus }) {
  return (
    <div className="keys-receipt" role="status">
      <h2>Saved {status.display_name}</h2>
      <dl>
        <dt>Profile id</dt><dd>{status.profile_ref}</dd>
        <dt>Provider</dt><dd>{status.provider_kind}</dd>
        <dt>Model</dt><dd>{status.model}</dd>
        <dt>Key stored</dt><dd>{status.secret_configured ? 'yes' : 'no'}</dd>
        <dt>Revision</dt><dd>{status.profile_revision}</dd>
      </dl>
    </div>
  );
}

/**
 * The keys section: one form per new model route on `@byok-sdk/keys/model-route`, submitted write-only through
 * `keys.submit`, and the K8 model list, which takes the new profile's entry through the Host's view-change hint.
 */
export function KeysSection() {
  const context: ModelRouteContext = useMemo(() => modelRouteContext(), []);
  const [draft, setDraft] = useState(() => createModelRouteDraft(context));
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome>();
  const { loaded } = useConversation(null);
  const view = modelRouteView(draft, context);
  const onChange: Change = change => setDraft(current => applyModelRouteChange(current, change, context));

  const submit = async () => {
    setBusy(true);
    setOutcome(undefined);
    const result = await submitModelRoute(draft, context, request => window.byok.call('keys.submit', request));
    setOutcome(result.outcome);
    if ('receipt' in result.outcome) {
      setDraft(createModelRouteDraft(context));
      setFormKey(value => value + 1);
    } else {
      setDraft(result.draft);
    }
    setBusy(false);
  };

  return (
    <div className="keys">
      <form key={formKey} className="keys-form" onSubmit={event => { event.preventDefault(); if (view.valid && !busy) void submit(); }}>
        <h1>Add a model provider</h1>
        {view.fields.filter(field => field.visible).map(field => {
          const body = (
            <>
              {LABELS[field.field]}{field.required ? ' *' : ''}
              <FieldInput view={field} draft={draft} onChange={onChange} />
              <FieldError view={field} />
            </>
          );
          // The capability checkboxes carry their own labels, which a label may not contain.
          return field.field === 'capabilities' ? <fieldset key={field.field}>{body}</fieldset> : <label key={field.field}>{body}</label>;
        })}
        <button type="submit" disabled={busy || !view.valid}>Save</button>
      </form>
      {outcome && ('receipt' in outcome ? <Receipt status={outcome.receipt} /> : <p className="keys-error" role="alert">{outcome.error}</p>)}
      <section className="keys-models">
        <h2>Models Bots can use</h2>
        {loaded?.error !== undefined && <p className="keys-error" role="alert">{loaded.error}</p>}
        {loaded?.snapshot && <ul>{loaded.snapshot.models.map(model => <li key={model.id}>{model.label}</li>)}</ul>}
      </section>
    </div>
  );
}
