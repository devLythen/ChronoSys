pub mod accounts;
pub mod audit;
pub mod bindings;
pub mod bots;
pub mod health;
pub mod providers;
pub mod sessions;
pub mod settings;
pub mod ws;

/// Validate secret_ref format: `env:*`, `file:*`, or non-empty literal.
pub fn validate_secret_ref(secret_ref: &str) -> Result<(), String> {
    if secret_ref.is_empty() {
        return Err("secret_ref must not be empty".into());
    }
    if let Some(rest) = secret_ref.strip_prefix("env:") {
        if rest.is_empty() {
            return Err("secret_ref env: requires a variable name".into());
        }
        return Ok(());
    }
    if let Some(rest) = secret_ref.strip_prefix("file:") {
        if rest.is_empty() {
            return Err("secret_ref file: requires a path".into());
        }
        return Ok(());
    }
    // literal secret allowed for local/dev; still non-empty
    Ok(())
}
