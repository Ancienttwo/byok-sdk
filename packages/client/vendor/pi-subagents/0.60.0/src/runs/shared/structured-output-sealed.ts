/** SDK sealed build backend. User-schema validation is explicitly unavailable. */
import type { JsonSchemaObject } from "../../shared/types.ts";
import type { StructuredOutputRuntime } from "./structured-output.ts";
export type { StructuredOutputRuntime } from "./structured-output.ts";

export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";
export const STRUCTURED_OUTPUT_ACCEPTANCE_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_ACCEPTANCE_CAPTURE";
export const MISSING_STRUCTURED_OUTPUT_CALL_ERROR = "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.";

function refuse(): never {
	throw new Error("sealed_structured_output_unsupported: structured-output requests are unavailable in the sealed runtime.");
}
export function assertStructuredOutputSupported(schema: unknown): void {
	if (schema !== undefined) refuse();
}
// Shape admission remains upstream-compatible; the actual feature request is
// refused at execution admission, including inherited and retained schemas.
export function assertJsonSchemaObject(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${label} must be a JSON Schema object.`);
}
export function createStructuredOutputToolParameters(_schema: JsonSchemaObject, _options: { acceptanceReport?: boolean } = {}): JsonSchemaObject { return refuse(); }
export function createStructuredOutputRuntime(_schema: JsonSchemaObject, _baseDir?: string, _options: { captureAcceptanceReport?: boolean } = {}): StructuredOutputRuntime { return refuse(); }
export async function validateStructuredOutputValue(_schema: JsonSchemaObject, _value: unknown): Promise<{ status: "valid" } | { status: "invalid"; message: string }> { return refuse(); }
export async function readStructuredOutput(_runtime: StructuredOutputRuntime): Promise<{ value?: unknown; error?: string }> { return refuse(); }
export function readStructuredOutputAcceptanceReport(_runtime: StructuredOutputRuntime): { value?: unknown; error?: string } { return refuse(); }
export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void { if (runtime !== undefined) refuse(); }
