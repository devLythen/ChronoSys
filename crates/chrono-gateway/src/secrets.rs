use anyhow::{Context, Result};

/// Resolve an account/provider secret reference from config DB.
///
/// Supported forms (per-row, never a single process-wide token):
/// - `env:NAME`  → environment variable `NAME`
/// - `file:PATH` → file contents (trimmed)
/// - anything else → literal secret (token pasted via WebUI)
pub fn resolve_secret(secret_ref: &str) -> Result<String> {
    if secret_ref.is_empty() {
        anyhow::bail!("empty secret_ref");
    }
    if let Some(env_var) = secret_ref.strip_prefix("env:") {
        if env_var.is_empty() {
            anyhow::bail!("env: requires a variable name");
        }
        return std::env::var(env_var)
            .with_context(|| format!("environment variable {env_var} not set"));
    }
    if let Some(path) = secret_ref.strip_prefix("file:") {
        if path.is_empty() {
            anyhow::bail!("file: requires a path");
        }
        return Ok(std::fs::read_to_string(path)
            .with_context(|| format!("read secret file {path}"))?
            .trim()
            .to_string());
    }
    Ok(secret_ref.to_string())
}
