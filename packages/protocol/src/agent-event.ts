import { z } from 'zod';

/**
 * Known AgentEvent variant type discriminators, kept as a standalone literal
 * list (not derived from {@link AgentEventSchema}'s internals) so both the
 * discriminated union below and the unknown-variant guard
 * ({@link UnknownAgentEventSchema}) can check against the exact same set
 * without reaching into zod's discriminated-union internals. Keep this in
 * sync with the `type` literals in {@link AgentEventSchema} — adding a new
 * known variant means adding it in both places.
 *
 * Exported (not module-private) so the freeze guard
 * (`__tests__/freeze-guard.test.ts`) can assert this list exactly matches
 * {@link AgentEventSchema}'s own variant `type` literals — a dual-authority
 * drift guard: without it, forgetting to add a new variant here (while still
 * adding it to the schema union) would silently fall through to
 * {@link isKnownAgentEvent}/{@link partitionAgentEvents} misclassifying a
 * well-formed known event as unknown, since those two functions only ever
 * consult this list, never the schema directly.
 */
export const KNOWN_AGENT_EVENT_TYPES: readonly string[] = [
  'progress',
  'tool_use',
  'tool_result',
  'artifact',
  'needs_approval',
  'turn_end',
  'error',
  'usage',
];

/**
 * Normalized event shape that every runtime adapter (pi / claude / codex)
 * translates its native JSONL output into. This is the interior of a
 * `task.progress` payload's `events` array.
 */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), tool: z.string(), input: z.unknown().optional() }),
  z.object({ type: z.literal('tool_result'), tool: z.string(), output: z.unknown().optional() }),
  z.object({ type: z.literal('artifact'), name: z.string(), contentType: z.string() }),
  z.object({ type: z.literal('needs_approval'), summary: z.string() }),
  z.object({ type: z.literal('turn_end') }),
  z.object({ type: z.literal('error'), message: z.string() }),
  /**
   * Token usage reported by a runtime turn — maps from codex
   * `turn.completed.usage` and claude `result` usage (adapters wired up in a
   * later wave; this is just the variant + schema). All fields optional
   * because runtimes report different subsets.
   */
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * Pre-freeze compatibility widening (the freeze blocker this schema fixes):
 * an unknown-type event — one a future runtime/protocol minor version
 * introduces — parses as an opaque passthrough placeholder instead of
 * hard-failing the entire `task.progress` batch it arrived in. Without this,
 * `TaskProgressPayloadSchema.events: z.array(AgentEventSchema)` would throw
 * on the whole array the moment one event had an unrecognized `type`, which
 * made the wire's "additive new variants are non-breaking" promise false for
 * the installed base — and unfixable post-freeze.
 *
 * The `.refine` guard is load-bearing, not decorative: it excludes every
 * KNOWN type literal, so a *malformed* known variant (e.g. `progress`
 * missing `text`) still fails validation instead of silently matching this
 * fallback. Tolerance is only for unknown TYPES, never for malformed known
 * ones — see {@link AgentEventOrUnknownSchema}, which is what actually
 * combines this with {@link AgentEventSchema} for real use.
 *
 * Deliberately asymmetric with envelope-level control/security fields
 * (`instruction`, `policy` — see `messages.ts`/`permission.ts`), which stay
 * fail-closed on unknown shapes with no equivalent widening: this tolerance
 * applies only to observability data (agent progress events), never to
 * control/security surfaces. That asymmetry is the freeze rule.
 */
export const UnknownAgentEventSchema = z
  .object({ type: z.string() })
  .passthrough()
  .refine(
    (event) => !KNOWN_AGENT_EVENT_TYPES.includes(event.type),
    'type refers to a known AgentEvent variant; malformed known variants must fail through AgentEventSchema, not fall back to unknown-tolerance',
  );

export type UnknownAgentEvent = z.infer<typeof UnknownAgentEventSchema>;

/**
 * The actual element schema for `TaskProgressPayloadSchema.events`
 * (`messages.ts`): a known, fully-typed {@link AgentEvent} OR an opaque
 * unknown-type placeholder. `z.union` (not `discriminatedUnion`) is required
 * here because the fallback branch matches on "not one of the known
 * literals", which a discriminated union can't express directly.
 */
export const AgentEventOrUnknownSchema = z.union([AgentEventSchema, UnknownAgentEventSchema]);

export type AgentEventOrUnknown = z.infer<typeof AgentEventOrUnknownSchema>;

/**
 * Type guard distinguishing a known, fully-typed {@link AgentEvent} from an
 * {@link UnknownAgentEvent} passthrough placeholder.
 */
export function isKnownAgentEvent(event: AgentEventOrUnknown): event is AgentEvent {
  return KNOWN_AGENT_EVENT_TYPES.includes(event.type);
}

/**
 * Split a `task.progress` events array into known (typed, actionable) and
 * unknown (opaque, safe-to-skip) events. Consumers should process `known`
 * and skip `unknown` rather than throwing on it — that's the point of the
 * pre-freeze tolerance above.
 */
export function partitionAgentEvents(events: readonly AgentEventOrUnknown[]): {
  known: AgentEvent[];
  unknown: UnknownAgentEvent[];
} {
  const known: AgentEvent[] = [];
  const unknown: UnknownAgentEvent[] = [];
  for (const event of events) {
    if (isKnownAgentEvent(event)) {
      known.push(event);
    } else {
      unknown.push(event);
    }
  }
  return { known, unknown };
}
