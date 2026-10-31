import { z } from 'zod';

/**
 * #1121: a device -> Host vocabulary a newer device may extend — a failure
 * class, a decline code, a content denial reason. A receiver must not refuse
 * the whole report for a value it does not know: it keeps the known meaning
 * of the values it knows and records any other well-formed token as
 * `unknown`, with the raw token kept beside it (`reported<Field>`). Control
 * vocabularies (message types, decisions, outcomes that select a shape) stay
 * closed.
 */
const OPEN_VOCABULARY_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Any well-formed open-vocabulary token, without a membership rule. */
export function openVocabularyToken(): z.ZodString {
  return z.string().regex(OPEN_VOCABULARY_TOKEN);
}

/** A well-formed token that is none of `known`: the raw value a receiver keeps as `reported<Field>`. */
export function unrecognizedToken(known: readonly string[]): z.ZodString {
  return openVocabularyToken().refine((value) => !known.includes(value), {
    message: 'a recognized value is not reported as unrecognized',
  });
}
