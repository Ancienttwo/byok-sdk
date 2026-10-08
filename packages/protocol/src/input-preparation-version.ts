/**
 * The ONE version of the input-preparation contract, shared by this relay wire
 * (the `agent.input.preparation` payload and the completion receipt summary)
 * and by the device-local request, receipt and artifact
 * (`@byok-sdk/client`'s `INPUT_PREPARATION_VERSION`, which is this value).
 *
 * The relay wire carries no version field of its own, so a version change is
 * made visible where admission actually happens: in the capability token
 * below. See `INPUT_PREPARATION_VERSION` in the client for what each version
 * changed.
 */
export const INPUT_PREPARATION_WIRE_VERSION = 9 as const;
