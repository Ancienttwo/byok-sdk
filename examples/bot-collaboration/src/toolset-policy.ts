import { ToolsetIdSchema } from '@byok-sdk/protocol';

/** Host declaration, not a proof about the tools' behavior. Never accept model annotations here. */
export function ownReadOnlyToolsets(ids: readonly string[] = []): readonly string[] {
  if (!Array.isArray(ids)) throw new Error('readOnlyToolsets must be an array of logical toolset IDs');
  if (ids.length > 64 || new Set(ids).size !== ids.length) throw new Error('Invalid read-only toolset policy');
  for (const id of ids) ToolsetIdSchema.parse(id);
  return Object.freeze([...ids]);
}
