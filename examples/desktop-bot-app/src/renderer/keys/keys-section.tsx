import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ProviderStatus } from '@byok-sdk/keys';
import {
  applyModelRouteChange, createModelRouteDraft, modelRouteContext, modelRouteView,
  type ModelRouteChange, type ModelRouteErrorCode, type ModelRouteFieldView, type ModelRouteModelChoice, type ModelRouteDraft,
  type ModelRouteContext, type PiModelApi,
} from '@byok-sdk/keys/model-route';
import { useConversation } from '../conversation/use-conversation.ts';
import './keys.css';
import { refusalOf, runLocked, storedProfile, submitModelRoute, submitReplaceSecret, type Refusal, type SubmitOutcome } from './submit.ts';

const ERROR_COPY: Readonly<Record<ModelRouteErrorCode, string>> = {
  required: 'Required.',
  invalid_value: 'This value is not valid.',
  invalid_url: 'Use an https URL (http only for localhost) with no user name, password, query or fragment, and no private-network address.',
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
/** Runs one submission under the section's single lock. */
type Run = (run: () => Promise<SubmitOutcome>) => Promise<void>;

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
          // "Other model…" clears the pick: an id typed below that the list does not hold makes the route manual.
          onChange(choice ? { field: 'model', value: choice.value, api: choice.api } : { field: 'model', value: '' });
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

function RefusalNote({ refusal }: { refusal: Refusal }) {
  return <p className="keys-error" role="alert">{refusal.code === undefined ? '' : `${refusal.code}: `}{refusal.message}</p>;
}

type Listed = { readonly statuses: readonly ProviderStatus[]; readonly refusal?: undefined } | { readonly statuses?: undefined; readonly refusal: Refusal };

/** The stored profiles from `keys.list`; each read is one custody child. `load` never rejects: a refusal is shown as listed. */
function useKeysList(): { listed: Listed | undefined; load: () => Promise<void> } {
  const [listed, setListed] = useState<Listed>();
  const load = useCallback(async () => {
    try {
      setListed({ statuses: await window.byok.call('keys.list', undefined) });
    } catch (error) {
      setListed({ refusal: refusalOf(error) });
    }
  }, []);
  return { listed, load };
}

/** A new model route, or the edit of a stored one. A stored key starts as kept, and a kept key is never sent. */
function RouteForm({ stored, busy, run }: { stored: ProviderStatus | null; busy: boolean; run: Run }) {
  const context: ModelRouteContext = useMemo(() => modelRouteContext({ stored: stored === null ? null : storedProfile(stored) }), [stored]);
  const [draft, setDraft] = useState(() => createModelRouteDraft(context));
  const view = modelRouteView(draft, context);
  const onChange: Change = change => setDraft(current => applyModelRouteChange(current, change, context));

  const submit = () => run(() => submitModelRoute(draft, context, stored, change => window.byok.call('keys.submit', change),
    next => flushSync(() => setDraft(next))));

  return (
    <form className="keys-form" onSubmit={event => { event.preventDefault(); if (view.valid && !busy) void submit(); }}>
      <h1>{stored === null ? 'Add a model provider' : `Edit ${stored.display_name}`}</h1>
      {/* Disabled while a submission is in flight under the section lock. */}
      <fieldset className="keys-fields" disabled={busy}>
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
      </fieldset>
      <button type="submit" disabled={busy || !view.valid}>Save</button>
    </form>
  );
}

/** Replaces the stored key of a profile and changes nothing else; the only way out of an unfinished credential change. */
function ReplaceKeyForm({ stored, busy, run }: { stored: ProviderStatus; busy: boolean; run: Run }) {
  const [secret, setSecret] = useState('');
  const submit = () => {
    const typed = secret;
    flushSync(() => setSecret(''));
    return run(() => submitReplaceSecret(stored.profile_ref, typed, change => window.byok.call('keys.submit', change)));
  };
  return (
    <form className="keys-form" onSubmit={event => { event.preventDefault(); if (secret !== '' && !busy) void submit(); }}>
      <h2>Replace the key of {stored.display_name}</h2>
      <fieldset className="keys-fields" disabled={busy}>
        <label>New API key *<input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></label>
      </fieldset>
      <button type="submit" disabled={busy || secret === ''}>Replace key</button>
    </form>
  );
}

function StoredList({ listed, editing, busy, onEdit, onReload }: {
  listed: Listed | undefined; editing: string | null; busy: boolean; onEdit: (status: ProviderStatus | null) => void; onReload: () => void;
}) {
  return (
    <section className="keys-stored">
      <h2>Stored providers</h2>
      {listed === undefined && <p>Loading…</p>}
      {listed?.refusal && <RefusalNote refusal={listed.refusal} />}
      {listed?.statuses && (
        <ul>
          {listed.statuses.map(status => (
            <li key={status.profile_ref}>
              <button type="button" disabled={busy} aria-current={status.profile_ref === editing} onClick={() => onEdit(status)}>
                {status.display_name} ({status.profile_ref}) · {status.provider_kind} {status.model}
                {' · '}{status.auth_mode === 'none' ? 'no key needed' : status.secret_configured ? 'key stored' : 'no key stored'}
                {status.configuration_pending && ' · unfinished key change: replace the key'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy} onClick={() => onEdit(null)}>New provider</button>
      <button type="button" disabled={busy} onClick={onReload}>Reload</button>
    </section>
  );
}

/**
 * The keys section: the stored profiles from `keys.list`, a model-route form that adds one or edits one, and a key
 * replacement for a stored one, each submitted write-only through `keys.submit`; and the K8 model list, which takes a
 * saved profile's entry through the Host's view-change hint.
 */
export function KeysSection() {
  const { listed, load } = useKeysList();
  const [editing, setEditing] = useState<ProviderStatus | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [outcome, setOutcome] = useState<SubmitOutcome>();
  // One lock for every keys call of the section (list read, submission, the read after a receipt): no two are in flight,
  // so no response is stale and the list on screen is current whenever the section is interactive. Held from the first read.
  const [busy, setBusy] = useState(true);
  const { loaded } = useConversation(null);

  const edit = (status: ProviderStatus | null) => {
    setEditing(status);
    setOutcome(undefined);
    setFormKey(value => value + 1);
  };
  const onOutcome = (next: SubmitOutcome) => {
    setOutcome(next);
    if ('receipt' in next) {
      setEditing(null);
      setFormKey(value => value + 1);
    }
  };
  const run: Run = work => runLocked(setBusy, work, onOutcome, load);
  const reload = async () => {
    setBusy(true);
    try { await load(); } finally { setBusy(false); }
  };
  useEffect(() => { void reload(); }, []);

  return (
    <div className="keys">
      <StoredList listed={listed} editing={editing?.profile_ref ?? null} busy={busy} onEdit={edit} onReload={() => void reload()} />
      <RouteForm key={`route-${formKey}`} stored={editing} busy={busy} run={run} />
      {editing !== null && editing.auth_mode !== 'none' && <ReplaceKeyForm key={`key-${formKey}`} stored={editing} busy={busy} run={run} />}
      {outcome && ('receipt' in outcome ? <Receipt status={outcome.receipt} /> : <RefusalNote refusal={outcome.refusal} />)}
      <section className="keys-models">
        <h2>Models Bots can use</h2>
        {loaded?.error !== undefined && <p className="keys-error" role="alert">{loaded.error}</p>}
        {loaded?.snapshot && <ul>{loaded.snapshot.models.map(model => <li key={model.id}>{model.label}</li>)}</ul>}
      </section>
    </div>
  );
}
