//! Single generic contract-enforced transport (`ByokShell.call`) bridging TSX and `byok-shell`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use byok_shell::{BridgeContract, SecretBytes};
use nsh_core::JsonValue;
use nsh_core::element::desktop::{launch_at_login, restart, set_launch_at_login};
use nsh_core::element::{Os, blocking, os};
use nsh_core::prelude::*;
use zeroize::Zeroizing;

use crate::supervisor::active_shell;

/// Formats a filesystem-safe UTC ISO-8601 timestamp (`YYYY-MM-DDTHH-MM-SS.mmmZ`) matching `stampOf`.
pub(crate) fn format_utc_stamp(now: SystemTime) -> String {
    let dur = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();
    let secs_of_day = total_secs.rem_euclid(86_400);
    let days = total_secs.div_euclid(86_400);

    // Howard Hinnant's civil-from-days algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);

    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}.{millis:03}Z")
}

/// Validates a renderer method against the embedded `bridge-contract.json` allowlist before dispatching.
pub(crate) fn validate_renderer_method(method: &str) -> Result<(), JsError> {
    let contract = BridgeContract::load()
        .map_err(|err| JsError::Error(err.to_string()).with_code("contract_error"))?;
    if !contract.allows_renderer_method(method) {
        return Err(JsError::Error(format!(
            "Bridge method `{method}` is not allowed by bridge-contract.json"
        ))
        .with_code("unknown_method"));
    }
    Ok(())
}

/// Validates params for login-item and `keys.submit` routes without touching any OS subprocess.
pub(crate) fn parse_login_item_set_param(params: &JsonValue) -> Result<bool, JsError> {
    params
        .as_object()
        .and_then(|obj| obj.get("enabled"))
        .and_then(JsonValue::as_bool)
        .ok_or_else(|| {
            JsError::Error("settings.setLoginItem needs { enabled: boolean }".to_owned())
                .with_code("invalid_params")
        })
}

async fn handle_login_item_get(params: &JsonValue) -> Result<JsonValue, JsError> {
    if !params.is_null() {
        return Err(JsError::Error("settings.loginItem takes no params".to_owned())
            .with_code("invalid_params"));
    }
    if os() == Os::Linux {
        return Ok(serde_json::json!({ "supported": false, "enabled": false }));
    }
    let enabled = launch_at_login().await;
    Ok(serde_json::json!({ "supported": true, "enabled": enabled }))
}

async fn handle_login_item_set(params: &JsonValue) -> Result<JsonValue, JsError> {
    let enabled = parse_login_item_set_param(params)?;
    if os() == Os::Linux {
        return Err(
            JsError::Error("Login item is not supported on Linux".to_owned())
                .with_code("method_failed"),
        );
    }
    set_launch_at_login(enabled)
        .await
        .map_err(|err| JsError::Error(err.to_string()).with_code("method_failed"))?;
    let reported = launch_at_login().await;
    Ok(serde_json::json!({ "supported": true, "enabled": reported }))
}

/// Executes one contract-allowlisted bridge call on behalf of TSX (`method`, optional JSON `params`).
pub(crate) async fn dispatch_call(
    method: String,
    params: Option<JsonValue>,
) -> Result<JsonValue, JsError> {
    validate_renderer_method(&method)?;
    let params = params.unwrap_or(JsonValue::Null);

    match method.as_str() {
        "settings.loginItem" => return handle_login_item_get(&params).await,
        "settings.setLoginItem" => return handle_login_item_set(&params).await,
        _ => {}
    }

    let shell = active_shell().ok_or_else(|| {
        JsError::Error("Host supervisor is not started".to_owned()).with_code("host_exited")
    })?;
    let router = shell.router;

    match method.as_str() {
        "keys.submit" => {
            if !params.is_object() {
                return Err(
                    JsError::Error("keys.submit needs an object CustodyChange payload".to_owned())
                        .with_code("invalid_params"),
                );
            }
            let mut raw = Zeroizing::new(
                serde_json::to_vec(&params)
                    .map_err(|err| JsError::Error(err.to_string()).with_code("invalid_params"))?,
            );
            drop(params);
            let secret = SecretBytes::new(std::mem::take(&mut *raw));
            blocking(move || router.dispatch_keys_submit(secret))
                .await
                .map_err(|err| JsError::Error(err.to_string()).with_code("method_failed"))?
                .map_err(|err| JsError::Error(err.message).with_code(&err.code))
        }
        "shell.restore" => {
            if !params.is_null() {
                return Err(
                    JsError::Error("shell.restore takes no params".to_owned())
                        .with_code("invalid_params"),
                );
            }
            let stamp = format_utc_stamp(SystemTime::now());
            let app_version = shell.app_version;
            let result = blocking(move || {
                let relaunched = AtomicBool::new(false);
                let out = router.restore(&app_version, &stamp, |failure| {
                    if let Some(err) = failure {
                        log::error!("Recovery restore failed: {err}");
                    }
                    relaunched.store(true, Ordering::Release);
                });
                (out, relaunched.load(Ordering::Acquire))
            })
            .await
            .map_err(|err| JsError::Error(err.to_string()).with_code("method_failed"))?;

            if result.1 {
                restart();
            }
            let success = result
                .0
                .map_err(|err| JsError::Error(err.message).with_code(&err.code))?;
            serde_json::to_value(success)
                .map_err(|err| JsError::Error(err.to_string()).with_code("method_failed"))
        }
        "shell.startFresh" => {
            if !params.is_null() {
                return Err(
                    JsError::Error("shell.startFresh takes no params".to_owned())
                        .with_code("invalid_params"),
                );
            }
            let stamp = format_utc_stamp(SystemTime::now());
            let result = blocking(move || {
                let relaunched = AtomicBool::new(false);
                let out = router.start_fresh(&stamp, |failure| {
                    if let Some(err) = failure {
                        log::error!("Recovery startFresh failed: {err}");
                    }
                    relaunched.store(true, Ordering::Release);
                });
                (out, relaunched.load(Ordering::Acquire))
            })
            .await
            .map_err(|err| JsError::Error(err.to_string()).with_code("method_failed"))?;

            if result.1 {
                restart();
            }
            let success = result
                .0
                .map_err(|err| JsError::Error(err.message).with_code(&err.code))?;
            serde_json::to_value(success)
                .map_err(|err| JsError::Error(err.to_string()).with_code("method_failed"))
        }
        _ => blocking(move || router.dispatch_renderer(&method, params))
            .await
            .map_err(|err| JsError::Error(err.to_string()).with_code("method_failed"))?
            .map_err(|err| JsError::Error(err.message).with_code(&err.code)),
    }
}
