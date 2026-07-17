import { z } from 'zod';

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
 * Known AgentEvent variant type discriminators — DERIVED directly from
 * {@link AgentEventSchema}'s own discriminated-union variants via
 * `z.toJSONSchema`, rather than hand-maintained as a second literal list.
 * This used to be a standalone array kept in sync with the schema above by
 * hand (dual authority); the freeze guard
 * (`__tests__/freeze-guard.test.ts`'s "dual-authority cross-check") already
 * asserted the two matched using this EXACT SAME `z.toJSONSchema` extraction
 * mechanism, which is why deriving it this way is safe: the guard already
 * proved this extraction produces the identical set the hand-written list
 * held. With the derivation below, the two can no longer drift apart at
 * all — there is only one authority now, {@link AgentEventSchema} itself.
 * The freeze guard test is kept anyway (now definitionally true rather than
 * a live check) as a regression net in case a future refactor reintroduces a
 * hand-written list.
 *
 * Exported (not module-private) so {@link isKnownAgentEvent} /
 * {@link partitionAgentEvents} (and the freeze guard) can check against the
 * exact same set without each reaching into zod's discriminated-union
 * internals directly. `z.toJSONSchema`'s output shape here (`.oneOf[].
 * properties.type.const`) is a public, documented zod v4 API — not
 * reaching into `._def`/internal fields — same as the freeze guard already
 * relies on.
 */
export const KNOWN_AGENT_EVENT_TYPES: readonly string[] = (
  z.toJSONSchema(AgentEventSchema) as unknown as { oneOf: Array<{ properties: { type: { const: string } } }> }
).oneOf.map((branch) => branch.properties.type.const);

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
