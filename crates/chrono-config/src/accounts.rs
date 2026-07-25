use rusqlite::{params, Connection};

use crate::models::PlatformAccount;
use crate::store::{ConfigError, Result};
use crate::providers::parse_json_or_empty;

pub struct AccountStore<'a> {
    pub(crate) conn: &'a Connection,
}

impl AccountStore<'_> {
    pub fn insert_account(&self, a: &PlatformAccount) -> Result<()> {
        self.conn.execute(
            "INSERT INTO platform_accounts (id, platform, adapter_id, enabled,
                    secret_ref, adapter_config_json, json_ext)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                a.id,
                a.platform,
                a.adapter_id,
                a.enabled as i32,
                a.secret_ref,
                serde_json::to_string(&a.adapter_config_json).unwrap_or_default(),
                serde_json::to_string(&a.json_ext).unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    pub fn update_account(&self, a: &PlatformAccount) -> Result<()> {
        let rows = self.conn.execute(
            "UPDATE platform_accounts SET platform=?2, adapter_id=?3,
                    enabled=?4, secret_ref=?5, adapter_config_json=?6, json_ext=?7,
                    updated_at=datetime('now')
             WHERE id=?1",
            params![
                a.id,
                a.platform,
                a.adapter_id,
                a.enabled as i32,
                a.secret_ref,
                serde_json::to_string(&a.adapter_config_json).unwrap_or_default(),
                serde_json::to_string(&a.json_ext).unwrap_or_default(),
            ],
        )?;
        if rows == 0 {
            return Err(ConfigError::NotFound { entity: "platform_accounts", id: a.id.clone() });
        }
        Ok(())
    }
    pub fn get_account(&self, id: &str) -> Result<PlatformAccount> {
        self.conn
            .query_row(
                "SELECT id, platform, adapter_id, enabled, secret_ref,
                        adapter_config_json, json_ext, created_at, updated_at
                 FROM platform_accounts WHERE id=?1",
                params![id],
                row_to_account,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ConfigError::NotFound {
                    entity: "platform_accounts",
                    id: id.into(),
                },
                other => ConfigError::Sqlite(other),
            })
    }

    pub fn list_accounts(&self) -> Result<Vec<PlatformAccount>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, platform, adapter_id, enabled, secret_ref,
                    adapter_config_json, json_ext, created_at, updated_at
             FROM platform_accounts ORDER BY id"
        )?;
        let rows = stmt.query_map([], row_to_account)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn list_enabled_accounts(&self) -> Result<Vec<PlatformAccount>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, platform, adapter_id, enabled, secret_ref,
                    adapter_config_json, json_ext, created_at, updated_at
             FROM platform_accounts WHERE enabled=1 ORDER BY id"
        )?;
        let rows = stmt.query_map([], row_to_account)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete_account(&self, id: &str) -> Result<()> {
        let rows = self.conn.execute("DELETE FROM platform_accounts WHERE id=?1", params![id])?;
        if rows == 0 {
            return Err(ConfigError::NotFound {
                entity: "platform_accounts",
                id: id.into(),
            });
        }
        Ok(())
    }
}

fn row_to_account(row: &rusqlite::Row) -> std::result::Result<PlatformAccount, rusqlite::Error> {
    Ok(PlatformAccount {
        id: row.get(0)?,
        platform: row.get(1)?,
        adapter_id: row.get(2)?,
        enabled: row.get::<_, i32>(3)? != 0,
        secret_ref: row.get(4)?,
        adapter_config_json: parse_json_or_empty(row.get::<_, String>(5)?),
        json_ext: parse_json_or_empty(row.get::<_, String>(6)?),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}
