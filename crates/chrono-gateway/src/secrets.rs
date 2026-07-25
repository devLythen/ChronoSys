use anyhow::Result;

/// Resolve a secret_ref to its literal value.
/// Only plaintext tokens are supported (no env/file resolution).
pub fn resolve_secret(secret_ref: &str) -> Result<String> {
    if secret_ref.trim().is_empty() {
        anyhow::bail!("empty secret_ref");
    }
    Ok(secret_ref.trim().to_string())
}
