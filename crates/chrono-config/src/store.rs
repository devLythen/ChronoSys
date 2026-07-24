use rusqlite::Connection;
use std::path::Path;
use thiserror::Error;

use crate::providers::ProviderStore;
use crate::accounts::AccountStore;
use crate::bots::BotStore;

const MIGRATION_001: &str = include_str!("migrations/001_init.sql");

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("not found: {entity} {id}")]
    NotFound { entity: &'static str, id: String },
    #[error("invalid state: {0}")]
    InvalidState(String),
}

pub type Result<T> = std::result::Result<T, ConfigError>;

/// Top-level config store.
pub struct ConfigStore {
    pub(crate) conn: Connection,
}

impl ConfigStore {
    /// Open (or create) the SQLite DB at `path`, then run pending migrations.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Open an in-memory database (for tests).
    pub fn open_in_memory() -> Result<Self> {
        Self::open(":memory:")
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now')),
                name TEXT NOT NULL
            );"
        )?;

        let current: i64 = self.conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |r| r.get(0),
            )?;

        if current < 1 {
            self.conn.execute_batch(MIGRATION_001)?;
            self.conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (1, '001_init')",
                [],
            )?;
        }

        Ok(())
    }

    // ── sub-store accessors ──────────────────────────────────────

    pub fn providers(&self) -> ProviderStore<'_> {
        ProviderStore { conn: &self.conn }
    }

    pub fn accounts(&self) -> AccountStore<'_> {
        AccountStore { conn: &self.conn }
    }

    pub fn bots(&self) -> BotStore<'_> {
        BotStore { conn: &self.conn }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_and_migrate_memory() {
        let store = ConfigStore::open_in_memory().unwrap();
        let count: i64 = store.conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(count >= 6);
    }
}
