use rusqlite::{params, Connection};

use crate::models::{Binding, BotProfile};
use crate::store::{ConfigError, Result};
use crate::providers::parse_json_or_empty;

pub struct BotStore<'a> {
    pub(crate) conn: &'a Connection,
}

// ── Bot Profiles ────────────────────────────────────────────────

impl BotStore<'_> {
    pub fn insert_bot(&self, b: &BotProfile) -> Result<()> {
        self.conn.execute(
            "INSERT INTO bot_profiles (id, model_ref, persona_id,
                    policy_json, json_ext)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                b.id,
                b.model_ref,
                b.persona_id,
                serde_json::to_string(&b.policy_json).unwrap_or_default(),
                serde_json::to_string(&b.json_ext).unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    pub fn update_bot(&self, b: &BotProfile) -> Result<()> {
        let rows = self.conn.execute(
            "UPDATE bot_profiles SET model_ref=?2, persona_id=?3,
                    policy_json=?4, json_ext=?5, updated_at=datetime('now')
             WHERE id=?1",
            params![
                b.id,
                b.model_ref,
                b.persona_id,
                serde_json::to_string(&b.policy_json).unwrap_or_default(),
                serde_json::to_string(&b.json_ext).unwrap_or_default(),
            ],
        )?;
        if rows == 0 {
            return Err(ConfigError::NotFound { entity: "bot_profiles", id: b.id.clone() });
        }
        Ok(())
    }
    pub fn get_bot(&self, id: &str) -> Result<BotProfile> {
        self.conn
            .query_row(
                "SELECT id, model_ref, persona_id,
                        policy_json, json_ext, created_at, updated_at
                 FROM bot_profiles WHERE id=?1",
                params![id],
                row_to_bot,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ConfigError::NotFound {
                    entity: "bot_profiles",
                    id: id.into(),
                },
                other => ConfigError::Sqlite(other),
            })
    }

    pub fn list_bots(&self) -> Result<Vec<BotProfile>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, model_ref, persona_id,
                    policy_json, json_ext, created_at, updated_at
             FROM bot_profiles ORDER BY id"
        )?;
        let rows = stmt.query_map([], row_to_bot)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete_bot(&self, id: &str) -> Result<()> {
        let rows = self.conn.execute("DELETE FROM bot_profiles WHERE id=?1", params![id])?;
        if rows == 0 {
            return Err(ConfigError::NotFound {
                entity: "bot_profiles",
                id: id.into(),
            });
        }
        Ok(())
    }
}

fn row_to_bot(row: &rusqlite::Row) -> std::result::Result<BotProfile, rusqlite::Error> {
    Ok(BotProfile {
        id: row.get(0)?,
        model_ref: row.get(1)?,
        persona_id: row.get(2)?,
        policy_json: parse_json_or_empty(row.get::<_, String>(3)?),
        json_ext: parse_json_or_empty(row.get::<_, String>(4)?),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

// ── Bindings ────────────────────────────────────────────────────

impl BotStore<'_> {
    pub fn insert_binding(&self, b: &Binding) -> Result<()> {
        self.conn.execute(
            "INSERT INTO bindings (id, account_id, chat_pattern, bot_profile_id, session_mode,
                    priority, enabled, json_ext)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                b.id,
                b.account_id,
                b.chat_pattern,
                b.bot_profile_id,
                b.session_mode,
                b.priority,
                b.enabled as i32,
                serde_json::to_string(&b.json_ext).unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    pub fn update_binding(&self, b: &Binding) -> Result<()> {
        let rows = self.conn.execute(
            "UPDATE bindings SET account_id=?2, chat_pattern=?3, bot_profile_id=?4,
                    session_mode=?5, priority=?6, enabled=?7, json_ext=?8,
                    updated_at=datetime('now')
             WHERE id=?1",
            params![
                b.id,
                b.account_id,
                b.chat_pattern,
                b.bot_profile_id,
                b.session_mode,
                b.priority,
                b.enabled as i32,
                serde_json::to_string(&b.json_ext).unwrap_or_default(),
            ],
        )?;
        if rows == 0 {
            return Err(ConfigError::NotFound { entity: "bindings", id: b.id.clone() });
        }
        Ok(())
    }

    pub fn get_binding(&self, id: &str) -> Result<Binding> {
        self.conn
            .query_row(
                "SELECT id, account_id, chat_pattern, bot_profile_id, session_mode, priority,
                        enabled, json_ext, created_at, updated_at
                 FROM bindings WHERE id=?1",
                params![id],
                row_to_binding,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ConfigError::NotFound {
                    entity: "bindings",
                    id: id.into(),
                },
                other => ConfigError::Sqlite(other),
            })
    }

    /// List all enabled bindings for a given account, ordered by priority desc.
    pub fn list_bindings_for_account(&self, account_id: &str) -> Result<Vec<Binding>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, account_id, chat_pattern, bot_profile_id, session_mode, priority,
                    enabled, json_ext, created_at, updated_at
             FROM bindings WHERE account_id=?1 AND enabled=1 ORDER BY priority DESC"
        )?;
        let rows = stmt.query_map(params![account_id], row_to_binding)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn list_all_bindings(&self) -> Result<Vec<Binding>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, account_id, chat_pattern, bot_profile_id, session_mode, priority,
                    enabled, json_ext, created_at, updated_at
             FROM bindings ORDER BY account_id, priority DESC"
        )?;
        let rows = stmt.query_map([], row_to_binding)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete_binding(&self, id: &str) -> Result<()> {
        let rows = self.conn.execute("DELETE FROM bindings WHERE id=?1", params![id])?;
        if rows == 0 {
            return Err(ConfigError::NotFound { entity: "bindings", id: id.into() });
        }
        Ok(())
    }
}

fn row_to_binding(row: &rusqlite::Row) -> std::result::Result<Binding, rusqlite::Error> {
    Ok(Binding {
        id: row.get(0)?,
        account_id: row.get(1)?,
        chat_pattern: row.get(2)?,
        bot_profile_id: row.get(3)?,
        session_mode: row.get(4)?,
        priority: row.get(5)?,
        enabled: row.get::<_, i32>(6)? != 0,
        json_ext: parse_json_or_empty(row.get::<_, String>(7)?),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}
