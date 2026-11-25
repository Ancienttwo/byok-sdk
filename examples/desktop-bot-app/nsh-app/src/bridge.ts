import { ByokShell } from "byok-nsh-adapter";
import { BridgeCallError } from "../../src/bridge/error.ts";
import type { BridgeMethods, RendererMethod } from "../../src/bridge/protocol.ts";

export { BridgeCallError };

export interface AdapterBridge {
  call<M extends RendererMethod>(
    method: M,
    params: BridgeMethods[M]["params"],
  ): Promise<BridgeMethods[M]["result"]>;
}

/** Maps a rejection from the `byok-nsh-adapter` boundary to its coded `BridgeCallError`. */
export function toBridgeCallError(error: unknown): BridgeCallError {
  const record =
    typeof error === "object" && error !== null
      ? (error as { readonly code?: unknown; readonly message?: unknown })
      : undefined;
  const code = typeof record?.code === "string" && record.code ? record.code : "method_failed";
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  return new BridgeCallError(code, message);
}

/** Creates a typed bridge over a raw transport invoker (defaults to `ByokShell.call`). */
export function createBridge(
  invoke: (method: string, params?: unknown | null) => Promise<unknown> = (method, params) =>
    ByokShell.call(method, params),
): AdapterBridge {
  return {
    call: async (method, params) => {
      try {
        return (await invoke(method, params ?? null)) as BridgeMethods[typeof method]["result"];
      } catch (error) {
        throw toBridgeCallError(error);
      }
    },
  };
}

/** Default production bridge routed through `ByokShell.call`. */
export const bridge: AdapterBridge = createBridge();

/**
 * ADR-052 D2 Option A secret boundary: clears the reactive secret signal synchronously
 * BEFORE handing the payload across the FFI bridge to `keys.submit`.
 */
export async function submitSecret(options: {
  clearSecret: () => void;
  buildPayload: () => BridgeMethods["keys.submit"]["params"];
  client?: AdapterBridge;
}): Promise<BridgeMethods["keys.submit"]["result"]> {
  const payload = options.buildPayload();
  options.clearSecret();
  const client = options.client ?? bridge;
  return await client.call("keys.submit", payload);
}
