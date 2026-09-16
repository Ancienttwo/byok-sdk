# @byok-sdk/implementation-identity

Node-only implementation identity measurement shared by `@byok-sdk/client`
and `@byok-sdk/keys`. It validates install records, measures artifact/interpreter
and sealed asset identity, commits the fixed launch-environment projection, and
reverifies immediately before spawn.

This package does not select runtimes, launch processes, resolve credentials,
or supply an installation authority. Client retains runtime launch policy;
keys retains OS credential custody. Core remains platform-neutral.

The shipped module uses only Node fs, crypto and path builtins. The fixed
credential-name exclusion inventory and loader-name classifier define measurement
semantics; callers do not supply alternate exemption sets. Unknown BYOK control
names fail closed. Credential values are not measured.

The package follows the SDK aligned release train. Client and keys packed
manifests must require the same exact version; it is not an umbrella namespace.
The existing client identity type names remain available as re-exports.

Moving measurement here does not establish full bundle closure, OS trust,
or completion of runtime final-spawn wiring. The installation permission boundary
and the caller's final-spawn check remain necessary.
