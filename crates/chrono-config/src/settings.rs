use rusqlite::{params, Connection};

use crate::models::Setting;
use crate::providers::parse_json_or_empty;
use crate::store::{ConfigError, Result};

pub struct SettingStore<'a> {
    pub(crate) conn: &'a Connection,
}

impl SettingStore<'_> {
    pub fn get(&self, key: &str) -> Result<Option<Setting>> {
        let mut stmt = self.conn.prepare(
            "SELECT key, value_json, updated_at FROM settings WHERE key=?1",
        )?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(Setting {
                key: row.get(0)?,
                value_json: parse_json_or_empty(row.get::<_, String>(1)?),
                updated_at: row.get(2)?,
            })),
            None => Ok(None),
        }
    }

    pub fn set(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value_json)
             VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET
                value_json=excluded.value_json,
                updated_at=datetime('now')",
            params![key, serde_json::to_string(value).unwrap_or_else(|_| "null".into())],
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Setting>> {
        let mut stmt = self.conn.prepare(
            "SELECT key, value_json, updated_at FROM settings ORDER BY key",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Setting {
                key: row.get(0)?,
                value_json: parse_json_or_empty(row.get::<_, String>(1)?),
                updated_at: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        let rows = self
            .conn
            .execute("DELETE FROM settings WHERE key=?1", params![key])?;
        if rows == 0 {
            return Err(ConfigError::NotFound {
                entity: "settings",
                id: key.into(),
            });
        }
        Ok(())
    }
}
