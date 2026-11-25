//! UI-agnostic Rust shell foundation for `examples/desktop-bot-app` (`#2460`).
//!
//! Owns bridge contract validation, Host supervision, NDJSON v2 multiplexing,
//! custody secret stdin handling, S1 recovery command orchestration, maintenance locking,
//! and three-OS sleep inhibition without depending on any UI framework or async runtime.

pub mod bridge;
pub mod command;
pub mod contract;
pub mod custody;
pub mod env;
pub mod host;
pub mod maintenance;
pub mod power;
pub mod recovery;
pub mod router;

pub use bridge::{
    BridgeClient, BridgeError, BridgeErrorCode, HostState, StopError, SupervisedHostState,
};
pub use command::{
    CommandError, CommandOutcome, HostCommandSpec, run_host_command, spawn_host_child,
};
pub use contract::{
    BridgeContract, ContractError, EXPECTED_BRIDGE_VERSION, EXPECTED_SCHEMA_VERSION, HostCommands,
};
pub use custody::{
    CustodyError, DEFAULT_CUSTODY_DEADLINE, SecretBytes, list_from_custody, submit_to_custody,
};
pub use env::{FOREIGN_RUNTIME_VARIABLES, filter_env_pairs, filtered_host_env};
pub use host::{HostSupervisor, HostSupervisorConfig, StateHintCoalescer};
pub use maintenance::{
    CustodyGuard, DEFAULT_CUSTODY_QUIT_WAIT, HandoverState, MaintenanceBusyError, MaintenanceGuard,
    MaintenanceLock, QuitOutcome,
};
pub use power::{
    DEFAULT_KEEP_AWAKE_REASON, DEFAULT_KEEP_AWAKE_WHO, KeepAwake, KeepAwakeBackend, KeepAwakeGuard,
    LinuxInhibitBackend, PowerError, SystemKeepAwakeBackend, select_linux_backend,
};
pub use recovery::{
    MovedEntry, RecoveryError, RestoreSuccess, ShellView, SnapshotInfo, SnapshotVersionView,
    StartFreshSuccess, host_is_stopped, run_restore, run_snapshot, run_snapshot_status,
    run_start_fresh, shell_restore, shell_start_fresh, shell_state,
};
pub use router::{HANDLED_MAIN_METHODS, LoginItemView, ShellRouteError, ShellRouter};
