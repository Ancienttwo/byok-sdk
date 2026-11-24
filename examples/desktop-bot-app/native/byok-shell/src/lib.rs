//! UI-agnostic Rust shell contract foundation for `examples/desktop-bot-app`.

pub mod contract;

pub use contract::{
    BridgeContract, ContractError, EXPECTED_BRIDGE_VERSION, EXPECTED_SCHEMA_VERSION, HostCommands,
};
