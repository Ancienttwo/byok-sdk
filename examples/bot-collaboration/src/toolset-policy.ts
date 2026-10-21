import { ToolsetIdSchema } from '@byok-sdk/protocol';
import type { ExecutionTemplate } from '@byok-sdk/example-host-execution-core';

/** Host declaration, not a proof about the tools' behavior. Never accept model annotations here. */
export function ownReadOnlyToolsets(ids: readonly string[] = []): readonly string[] {
  if (!Array.isArray(ids)) throw new Error('readOnlyToolsets must be an array of logical toolset IDs');
  if (ids.length > 64 || new Set(ids).size !== ids.length) throw new Error('Invalid read-only toolset policy');
  for (const id of ids) ToolsetIdSchema.parse(id);
  return Object.freeze([...ids]);
}

export function admitBotToolsets(execution: ExecutionTemplate, readOnlyToolsets: readonly string[] = []): void {
  for (const id of execution.payload.requiredToolsets ?? []) {
    if (!readOnlyToolsets.includes(id)) throw new Error(`Bot executions cannot have connector toolsets not declared read-only by the Host: ${id}`);
  }
}
