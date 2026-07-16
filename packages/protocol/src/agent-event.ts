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
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
