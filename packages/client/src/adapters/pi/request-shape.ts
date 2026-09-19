/**
 * Request-shape drift detection for the provider boundary.
 *
 * Budget coverage (INV-06) needs to know what the provider request actually
 * carries. A caller can obtain the exact payload through its own transport, but
 * it cannot know when the provider adds a key it has never accounted for.
 *
 * The failure mode that matters is silent under-coverage. So this module does
 * not try to predict the provider: it records the keys this client knows how to
 * account for, and refuses when a payload carries anything else. Drift then
 * surfaces as a typed refusal instead of a quietly wrong budget.
 *
 * The inventory is measured, not guessed: `buildParams` in the provider adapter
 * builds the whole request in one function, and these are its keys as observed
 * on 2026-09-19 (see docs/researches/2026-09-19-official-pi-op2u-upstream-request.md
 * §9). Adding a key here is a deliberate act that must come with an accounting
 * rule; letting one appear by accident is what this check exists to prevent.
 */

/** How a request key participates in the budget. */
export type RequestKeyClass =
  /** Carries model-visible content; the counter must measure it. */
  | 'content'
  /** Changes framing or sampling without carrying conversation content. */
  | 'framing'
  /** Transport/addressing concern, no token effect. */
  | 'transport';

/**
 * Known top-level keys for the first supported provider surface
 * (`openai-completions`, the restricted text/HTTP path).
 */
export const OPENAI_COMPLETIONS_REQUEST_KEYS: Readonly<Record<string, RequestKeyClass>> = Object.freeze({
  // Content the counter must cover.
  messages: 'content',
  tools: 'content',
  model: 'content',
  // Framing and sampling.
  max_completion_tokens: 'framing',
  max_tokens: 'framing',
  temperature: 'framing',
  reasoning_effort: 'framing',
  thinking: 'framing',
  enable_thinking: 'framing',
  chat_template_kwargs: 'framing',
  tool_choice: 'framing',
  tool_stream: 'framing',
  stream_options: 'framing',
  stream: 'framing',
  // Transport and caching.
  store: 'transport',
  prompt_cache_key: 'transport',
  prompt_cache_retention: 'transport',
  priority: 'transport',
  provider: 'transport',
  providerOptions: 'transport',
});

/** Keys whose content must be measured by the counter. */
export const CONTENT_REQUEST_KEYS: readonly string[] = Object.entries(OPENAI_COMPLETIONS_REQUEST_KEYS)
  .filter(([, keyClass]) => keyClass === 'content')
  .map(([key]) => key)
  .sort();

export interface RequestShapeReport {
  api: string;
  /** Keys present in the payload that this client knows how to account for. */
  known: string[];
  /** Keys present in the payload that it does not. Never silently ignored. */
  unknown: string[];
  /** Class of every known key that is actually present. */
  classes: Record<string, RequestKeyClass>;
  /** Known keys that this request happened not to carry. Informational only. */
  absent: string[];
}

/** Thrown when a request carries a key this client cannot account for. */
export class RequestShapeDriftError extends Error {
  readonly code = 'request_shape_drift';
  readonly api: string;
  readonly unknownKeys: readonly string[];

  constructor(api: string, unknownKeys: readonly string[]) {
    super(
      `${api}: request carries key(s) this client cannot account for: ${unknownKeys.join(', ')}. ` +
        'Budget coverage cannot be claimed for them, so the request is refused rather than counted approximately.',
    );
    this.name = 'RequestShapeDriftError';
    this.api = api;
    this.unknownKeys = unknownKeys;
  }
}

function tableFor(api: string): Readonly<Record<string, RequestKeyClass>> | undefined {
  return api === 'openai-completions' ? OPENAI_COMPLETIONS_REQUEST_KEYS : undefined;
}

/**
 * Compare an observed payload against the recorded inventory.
 *
 * An unknown API has no inventory at all, which is itself drift: this client
 * cannot describe what that request carries.
 */
export function classifyRequestShape(api: string, payload: unknown): RequestShapeReport {
  const table = tableFor(api);
  if (table === undefined) {
    return {
      api,
      known: [],
      unknown: typeof payload === 'object' && payload !== null ? Object.keys(payload).sort() : [],
      classes: {},
      absent: [],
    };
  }
  const present = typeof payload === 'object' && payload !== null ? Object.keys(payload) : [];
  const known: string[] = [];
  const unknown: string[] = [];
  const classes: Record<string, RequestKeyClass> = {};
  for (const key of present.sort()) {
    const keyClass = table[key];
    if (keyClass === undefined) unknown.push(key);
    else {
      known.push(key);
      classes[key] = keyClass;
    }
  }
  const absent = Object.keys(table)
    .filter((key) => !known.includes(key))
    .sort();
  return { api, known, unknown, classes, absent };
}

/** Classify, and refuse when anything is unaccounted for. */
export function assertRequestShape(api: string, payload: unknown): RequestShapeReport {
  const report = classifyRequestShape(api, payload);
  if (report.unknown.length > 0) throw new RequestShapeDriftError(api, report.unknown);
  return report;
}
