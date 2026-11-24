use byok_shell::{BridgeContract, ContractError, EXPECTED_BRIDGE_VERSION, EXPECTED_SCHEMA_VERSION};

const VALID_CONTRACT_JSON: &str =
    include_str!("../../../src/bridge/bridge-contract.json");

#[test]
fn embedded_bridge_contract_loads_and_matches_expected_versions() {
    let contract = BridgeContract::load().expect("embedded bridge-contract.json must load cleanly");

    assert_eq!(contract.schema_version, EXPECTED_SCHEMA_VERSION);
    assert_eq!(contract.bridge_version, EXPECTED_BRIDGE_VERSION);

    assert!(contract.allows_shell_to_host_method("keys.profilesChanged"));
    assert!(contract.allows_host_method("keys.profilesChanged"));
    assert!(!contract.allows_renderer_method("keys.profilesChanged"));
    assert!(!contract.is_main_method("keys.profilesChanged"));

    for cmd in [
        contract.host_commands.custody.as_str(),
        contract.host_commands.start_fresh.as_str(),
        contract.host_commands.snapshot.as_str(),
        contract.host_commands.snapshot_status.as_str(),
        contract.host_commands.restore.as_str(),
    ] {
        assert!(!cmd.trim().is_empty(), "host command must not be empty");
    }
}

#[test]
fn contract_parser_fails_closed_on_version_schema_and_invariant_drift() {
    let valid = VALID_CONTRACT_JSON.replace("\r\n", "\n");

    let wrong_schema = valid.replace("\"schemaVersion\": 2", "\"schemaVersion\": 1");
    assert_ne!(wrong_schema, valid);
    assert_eq!(
        BridgeContract::parse_str(&wrong_schema),
        Err(ContractError::UnsupportedSchemaVersion {
            expected: EXPECTED_SCHEMA_VERSION,
            actual: 1,
        })
    );

    let wrong_bridge = valid.replace("\"bridgeVersion\": 2", "\"bridgeVersion\": 3");
    assert_ne!(wrong_bridge, valid);
    assert_eq!(
        BridgeContract::parse_str(&wrong_bridge),
        Err(ContractError::UnsupportedBridgeVersion {
            expected: EXPECTED_BRIDGE_VERSION,
            actual: 3,
        })
    );

    let unknown_field = format!("{{\"unexpected\":true,{}}}", &valid.trim_start()[1..]);
    assert!(matches!(BridgeContract::parse_str(&unknown_field), Err(ContractError::Parse(_))));

    let missing_field = valid.replace("\"shellToHostMethods\": [\n    \"keys.profilesChanged\"\n  ],\n", "");
    assert_ne!(missing_field, valid);
    assert!(matches!(BridgeContract::parse_str(&missing_field), Err(ContractError::Parse(_))));

    let exposed_shell_to_host = valid.replace(
        "\"rendererMethods\": [\n    \"status\",",
        "\"rendererMethods\": [\n    \"status\",\n    \"keys.profilesChanged\",",
    );
    assert_ne!(exposed_shell_to_host, valid);
    assert!(matches!(
        BridgeContract::parse_str(&exposed_shell_to_host),
        Err(ContractError::InvariantViolation(_))
    ));
}
