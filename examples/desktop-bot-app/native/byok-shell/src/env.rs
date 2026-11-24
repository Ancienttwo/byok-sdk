//! Host child environment sanitization (`FOREIGN_RUNTIME_VARIABLES`).

use std::ffi::OsString;

/// Variables that would redirect the Host's Node runtime or Pi assets outside `resources/host/`.
pub const FOREIGN_RUNTIME_VARIABLES: &[&str] = &[
    "NODE_OPTIONS",
    "NODE_PATH",
    "PI_PACKAGE_DIR",
    "BYOK_PI_BIN",
    "ELECTRON_RUN_AS_NODE",
];

fn is_foreign_runtime_var(name: &str) -> bool {
    FOREIGN_RUNTIME_VARIABLES
        .iter()
        .any(|blocked| name.eq_ignore_ascii_case(blocked))
}

/// Filters `(key, value)` environment pairs by stripping `FOREIGN_RUNTIME_VARIABLES` case-insensitively.
pub fn filter_env_pairs<I, K, V>(pairs: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<OsString>,
    V: Into<OsString>,
{
    pairs
        .into_iter()
        .filter_map(|(key, value)| {
            let key_str = key.into().into_string().ok()?;
            if is_foreign_runtime_var(&key_str) {
                return None;
            }
            let value_str = value.into().into_string().ok()?;
            Some((key_str, value_str))
        })
        .collect()
}

/// Returns the current process environment with `FOREIGN_RUNTIME_VARIABLES` stripped.
pub fn filtered_host_env() -> Vec<(String, String)> {
    filter_env_pairs(std::env::vars_os())
}
