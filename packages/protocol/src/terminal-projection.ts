import { z } from 'zod';
import { checkResultSchema, type ResultSchema } from './result-schema';

export const TerminalProjectionContractSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u, 'terminal projection contracts must be opaque lowercase ids');

/**
 * The frozen outcome schema of a result-document offer (wire v3). The value
 * is kept exactly as sent; {@link checkResultSchema} decides admission, so
 * every decode (Host submit, server/cloud parse, daemon admission) applies
 * the one subset guard and reports its capped issues.
 */
export const ResultDocumentSchemaSchema = z.custom<ResultSchema>().superRefine((value, ctx) => {
  const check = checkResultSchema(value);
  if (check.ok) return;
  for (const issue of check.issues) {
    ctx.addIssue({
      code: 'custom',
      message: `result schema ${check.reason} at '${issue.pointer}' (${issue.keyword}): ${issue.message}`,
      params: { reason: check.reason, pointer: issue.pointer, keyword: issue.keyword },
    });
  }
  if (check.truncated) {
    ctx.addIssue({ code: 'custom', message: 'result schema issues truncated', params: { reason: check.reason, truncated: true } });
  }
});

/** Offer-scoped authority: explicit bypass or one required structured result with its frozen schema. */
export const TerminalProjectionSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({
    mode: z.literal('result-document'),
    contract: TerminalProjectionContractSchema,
    schema: ResultDocumentSchemaSchema,
  }).strict(),
]);
export type TerminalProjectionSelection = z.infer<typeof TerminalProjectionSelectionSchema>;
