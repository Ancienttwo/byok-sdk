//! Fail-closed loader for `src/bridge/bridge-contract.json` (S2 single authority).

use std::collections::HashSet;
use std::fmt;

use serde::Deserialize;

/// Embedded S2 bridge contract emitted by `examples/desktop-bot-app/scripts/generate-bridge-contract.mjs`.
const RAW_CONTRACT_JSON: &str = include_str!("../../../src/bridge/bridge-contract.json");

/// Expected S2 contract JSON schema version.
pub const EXPECTED_SCHEMA_VERSION: u32 = 2;

/// Expected NDJSON bridge protocol version shared between shell and Host.
pub const EXPECTED_BRIDGE_VERSION: u32 = 3;

const REQUIRED_CORE_METHODS: [&str; 3] = ["hello", "status", "shutdown"];

/// Host CLI subcommands invoked via S1/custody argv re-entry.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCommands {
    pub custody: String,
    pub start_fresh: String,
    pub snapshot: String,
    pub snapshot_status: String,
    pub restore: String,
}

/// Machine-readable bridge allowlist and protocol contract consumed by `byok-shell`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeContract {
    pub schema_version: u32,
    pub bridge_version: u32,
    pub ipc_channel: String,
    pub state_hint_channel: String,
    pub core_methods: Vec<String>,
    pub renderer_methods: Vec<String>,
    pub main_methods: Vec<String>,
    pub host_methods: Vec<String>,
    pub shell_to_host_methods: Vec<String>,
    pub host_commands: HostCommands,
}

/// Refusal reasons returned when loading or validating the bridge contract.
#[derive(Debug, PartialEq, Eq)]
pub enum ContractError {
    Parse(String),
    UnsupportedSchemaVersion { expected: u32, actual: u32 },
    UnsupportedBridgeVersion { expected: u32, actual: u32 },
    EmptyField { field: &'static str },
    DuplicateMethod { list: &'static str, method: String },
    MissingCoreMethod { method: &'static str },
    InvariantViolation(&'static str),
}

impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(reason) => write!(f, "invalid bridge contract JSON: {reason}"),
            Self::UnsupportedSchemaVersion { expected, actual } => {
                write!(f, "unsupported contract schemaVersion {actual} (expected {expected})")
            }
            Self::UnsupportedBridgeVersion { expected, actual } => {
                write!(f, "unsupported contract bridgeVersion {actual} (expected {expected})")
            }
            Self::EmptyField { field } => write!(f, "bridge contract field `{field}` must not be empty"),
            Self::DuplicateMethod { list, method } => {
                write!(f, "duplicate method `{method}` in bridge contract `{list}`")
            }
            Self::MissingCoreMethod { method } => {
                write!(f, "bridge contract `coreMethods` is missing required `{method}`")
            }
            Self::InvariantViolation(detail) => write!(f, "bridge contract invariant failed: {detail}"),
        }
    }
}

impl std::error::Error for ContractError {}

fn ensure_non_empty(field: &'static str, value: &str) -> Result<(), ContractError> {
    if value.trim().is_empty() {
        return Err(ContractError::EmptyField { field });
    }
    Ok(())
}

fn validate_unique_methods<'a>(
    list: &'static str,
    methods: &'a [String],
) -> Result<HashSet<&'a str>, ContractError> {
    let mut set = HashSet::with_capacity(methods.len());
    for method in methods {
        ensure_non_empty(list, method)?;
        if !set.insert(method.as_str()) {
            return Err(ContractError::DuplicateMethod {
                list,
                method: method.clone(),
            });
        }
    }
    Ok(set)
}

impl BridgeContract {
    /// Loads and strictly validates the compile-time embedded `bridge-contract.json`.
    pub fn load() -> Result<Self, ContractError> {
        Self::parse_str(RAW_CONTRACT_JSON)
    }

    /// Parses and validates a JSON contract payload, failing closed on any version or invariant drift.
    pub fn parse_str(raw: &str) -> Result<Self, ContractError> {
        let contract: Self =
            serde_json::from_str(raw).map_err(|err| ContractError::Parse(err.to_string()))?;

        if contract.schema_version != EXPECTED_SCHEMA_VERSION {
            return Err(ContractError::UnsupportedSchemaVersion {
                expected: EXPECTED_SCHEMA_VERSION,
                actual: contract.schema_version,
            });
        }
        if contract.bridge_version != EXPECTED_BRIDGE_VERSION {
            return Err(ContractError::UnsupportedBridgeVersion {
                expected: EXPECTED_BRIDGE_VERSION,
                actual: contract.bridge_version,
            });
        }

        for (field, value) in [
            ("ipcChannel", contract.ipc_channel.as_str()),
            ("stateHintChannel", contract.state_hint_channel.as_str()),
            ("hostCommands.custody", contract.host_commands.custody.as_str()),
            ("hostCommands.startFresh", contract.host_commands.start_fresh.as_str()),
            ("hostCommands.snapshot", contract.host_commands.snapshot.as_str()),
            ("hostCommands.snapshotStatus", contract.host_commands.snapshot_status.as_str()),
            ("hostCommands.restore", contract.host_commands.restore.as_str()),
        ] {
            ensure_non_empty(field, value)?;
        }

        let core = validate_unique_methods("coreMethods", &contract.core_methods)?;
        let renderer = validate_unique_methods("rendererMethods", &contract.renderer_methods)?;
        let main = validate_unique_methods("mainMethods", &contract.main_methods)?;
        let host = validate_unique_methods("hostMethods", &contract.host_methods)?;
        let shell_to_host =
            validate_unique_methods("shellToHostMethods", &contract.shell_to_host_methods)?;

        for required in REQUIRED_CORE_METHODS {
            if !core.contains(required) {
                return Err(ContractError::MissingCoreMethod { method: required });
            }
        }
        if core.len() != REQUIRED_CORE_METHODS.len() {
            return Err(ContractError::InvariantViolation(
                "coreMethods must contain exactly hello, status, and shutdown",
            ));
        }
        if !renderer.contains("status") {
            return Err(ContractError::InvariantViolation(
                "rendererMethods must include status",
            ));
        }

        for method in &core {
            if main.contains(method) || host.contains(method) || shell_to_host.contains(method) {
                return Err(ContractError::InvariantViolation(
                    "coreMethods must not overlap mainMethods, hostMethods, or shellToHostMethods",
                ));
            }
        }

        for method in &main {
            if !renderer.contains(method) {
                return Err(ContractError::InvariantViolation(
                    "every mainMethods entry must appear in rendererMethods",
                ));
            }
            if host.contains(method) {
                return Err(ContractError::InvariantViolation(
                    "mainMethods must not overlap hostMethods",
                ));
            }
        }

        for method in &shell_to_host {
            if !host.contains(method) {
                return Err(ContractError::InvariantViolation(
                    "every shellToHostMethods entry must appear in hostMethods",
                ));
            }
            if renderer.contains(method) || main.contains(method) {
                return Err(ContractError::InvariantViolation(
                    "shellToHostMethods must not appear in rendererMethods or mainMethods",
                ));
            }
        }

        for method in &renderer {
            if !main.contains(method) && *method != "status" && !host.contains(method) {
                return Err(ContractError::InvariantViolation(
                    "non-main rendererMethods entries other than status must appear in hostMethods",
                ));
            }
        }

        Ok(contract)
    }

    /// Returns whether the renderer is permitted to invoke `method`.
    pub fn allows_renderer_method(&self, method: &str) -> bool {
        self.renderer_methods.iter().any(|entry| entry == method)
    }

    /// Returns whether `method` is answered locally by main/shell rather than forwarded to the Host.
    pub fn is_main_method(&self, method: &str) -> bool {
        self.main_methods.iter().any(|entry| entry == method)
    }

    /// Returns whether `method` is a renderer-callable method forwarded to the Host (`status` or domain host method).
    pub fn allows_renderer_forwarded_host_method(&self, method: &str) -> bool {
        self.allows_renderer_method(method) && !self.is_main_method(method)
    }

    /// Returns whether `method` is a shell-only Host call excluded from renderer callers.
    pub fn allows_shell_to_host_method(&self, method: &str) -> bool {
        self.shell_to_host_methods.iter().any(|entry| entry == method)
    }

    /// Returns whether the Host bridge serves domain method `method`.
    pub fn allows_host_method(&self, method: &str) -> bool {
        self.host_methods.iter().any(|entry| entry == method)
    }
}
