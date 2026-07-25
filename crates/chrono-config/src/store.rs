use rusqlite::Connection;
use std::path::Path;
use thiserror::Error;

use crate::providers::ProviderStore;
use crate::accounts::AccountStore;
use crate::bots::BotStore;
use crate::settings::SettingStore;
use crate::personas::PersonaStore;
const MIGRATION_001: &str = include_str!("migrations/001_init.sql");
const MIGRATION_002: &str = include_str!("migrations/002_personas.sql");
const MIGRATION_003: &str = include_str!("migrations/003_drop_bot_enabled.sql");
const MIGRATION_004: &str = include_str!("migrations/004_drop_provider_enabled.sql");
const MIGRATION_005: &str = include_str!("migrations/005_cleanup_llm_models.sql");
const MIGRATION_006: &str = include_str!("migrations/006_model_params.sql");
const MIGRATION_007: &str = include_str!("migrations/007_drop_display_name.sql");

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

        if current < 2 {
            self.conn.execute_batch(MIGRATION_002)?;
            self.conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (2, '002_personas')",
                [],
            )?;
        }

        if current < 3 {
            self.conn.execute_batch(MIGRATION_003)?;
            self.conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (3, '003_drop_bot_enabled')",
                [],
            )?;
        }

        if current < 4 {
            self.conn.execute_batch(MIGRATION_004)?;
            self.conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (4, '004_drop_provider_enabled')",
                [],
            )?;
        }

        if current < 5 {
            self.conn.execute_batch(MIGRATION_005)?;
            self.conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (5, '005_cleanup_llm_models')",
                [],
            )?;
        }

        if current < 6 {
            self.conn.execute_batch(MIGRATION_006)?;
            self.conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (6, '006_model_params')",
                [],
            )?;
        }

        if current < 7 {
            self.conn.execute_batch(MIGRATION_007)?;
            self.conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (7, '007_drop_display_name')",
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

    pub fn personas(&self) -> PersonaStore<'_> {
        PersonaStore { conn: &self.conn }
    }

    pub fn bots(&self) -> BotStore<'_> {
        BotStore { conn: &self.conn }
    }

    pub fn settings(&self) -> SettingStore<'_> {
        SettingStore { conn: &self.conn }
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
