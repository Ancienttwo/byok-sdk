import { z } from 'zod';

/** Capability required before an offer may select terminal projection behavior. */
export const TERMINAL_PROJECTION_SELECTION_CAPABILITY = 'terminal-projection-selection' as const;

export const TerminalProjectionContractSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u, 'terminal projection contracts must be opaque lowercase ids');

/** Offer-scoped authority: explicit bypass or one required structured result. */
export const TerminalProjectionSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({
    mode: z.literal('result-document'),
    contract: TerminalProjectionContractSchema,
  }).strict(),
]);
export type TerminalProjectionSelection = z.infer<typeof TerminalProjectionSelectionSchema>;
