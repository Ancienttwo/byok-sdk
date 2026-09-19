/**
 * The prepared-input compiler version this client consumes.
 *
 * A Host that must declare a runtime's `nativeProvenance` needs this number, and
 * it is the SDK's own authority: a locally copied value would drift silently on
 * the next fork build, while this one is what the client actually prepares input
 * against and what it compares an attested record to.
 *
 * It lives in its own module on purpose. Re-exporting it from the prepared-input
 * implementation would drag that whole declaration closure — including
 * fork-only subpath types — into this package's public type surface, for the sake
 * of one number.
 */
export const SUPPORTED_PREPARED_COMPILER_VERSION = 2;
