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
            let adapter = TelegramAdapter::new(
                token,
                account.id.clone(),
            );
            Ok(Arc::new(adapter))
        }
        other => bail!("unsupported platform '{other}' for account {}", account.id),
    }
}
