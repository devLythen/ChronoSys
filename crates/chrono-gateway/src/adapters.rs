use std::sync::Arc;

use anyhow::{bail, Context, Result};
use chrono_adapter_telegram::TelegramAdapter;
use chrono_config::PlatformAccount;
use chrono_ipc::adapter::PlatformAdapter;

use crate::secrets::resolve_secret;

/// Build a live platform adapter for an enabled account.
/// Secrets are resolved here from WebUI-written `secret_ref`, never at CLI boot.
pub fn build_adapter(account: &PlatformAccount) -> Result<Arc<dyn PlatformAdapter>> {
    if !account.enabled {
        bail!("account {} is disabled", account.id);
    }
    match account.platform.as_str() {
        "telegram" => {
            let token = resolve_secret(&account.secret_ref).with_context(|| {
                format!("resolve secret for account {} (telegram)", account.id)
            })?;
            let api_url = account_config(account, "api_url")
                .or_else(|| env_value(&["CHRONO_TELEGRAM_API_URL"]));
            let proxy_url = if api_url.as_deref().is_some_and(is_local_url) {
                None
            } else {
                account_config(account, "proxy_url").or_else(|| {
                    env_value(&[
                        "CHRONO_TELEGRAM_PROXY",
                        "TELOXIDE_PROXY",
                        "HTTPS_PROXY",
                        "https_proxy",
                        "ALL_PROXY",
                        "all_proxy",
                    ])
                })
            };
            let adapter = TelegramAdapter::new(
                token,
                account.id.clone(),
                proxy_url,
                api_url,
            )
            .with_context(|| format!("build Telegram adapter for account {}", account.id))?;
            Ok(Arc::new(adapter))
        }
        other => bail!("unsupported platform '{other}' for account {}", account.id),
    }
}

fn account_config(account: &PlatformAccount, key: &str) -> Option<String> {
    account
        .adapter_config_json
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn env_value(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn is_local_url(raw: &str) -> bool {
    url::Url::parse(raw)
        .ok()
        .and_then(|url| url.host_str().map(ToOwned::to_owned))
        .is_some_and(|host| {
            host == "localhost" || host == "127.0.0.1" || host == "::1"
        })
}
