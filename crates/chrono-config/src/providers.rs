use rusqlite::{params, Connection};

use crate::models::*;
use crate::store::{ConfigError, Result};

pub struct ProviderStore<'a> {
    pub(crate) conn: &'a Connection,
}

// ── LLM Providers ───────────────────────────────────────────────

impl ProviderStore<'_> {
    pub fn insert_provider(&self, p: &LlmProvider) -> Result<()> {
        self.conn.execute(
            "INSERT INTO llm_providers (id, kind, base_url, display_name, json_ext)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                p.id,
                p.kind,
                p.base_url,
                p.display_name,
                serde_json::to_string(&p.json_ext).unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    pub fn update_provider(&self, p: &LlmProvider) -> Result<()> {
        let rows = self.conn.execute(
            "UPDATE llm_providers SET kind=?2, base_url=?3, display_name=?4, json_ext=?5,
                    updated_at=datetime('now')
             WHERE id=?1",
            params![
                p.id,
                p.kind,
                p.base_url,
                p.display_name,
                serde_json::to_string(&p.json_ext).unwrap_or_default(),
            ],
        )?;
        if rows == 0 {
            return Err(ConfigError::NotFound { entity: "llm_providers", id: p.id.clone() });
        }
        Ok(())
    }

    pub fn get_provider(&self, id: &str) -> Result<LlmProvider> {
        self.conn
            .query_row(
                "SELECT id, kind, base_url, display_name, json_ext, created_at, updated_at
                 FROM llm_providers WHERE id=?1",
                params![id],
                row_to_provider,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ConfigError::NotFound {
                    entity: "llm_providers",
                    id: id.into(),
                },
                other => ConfigError::Sqlite(other),
            })
    }

    pub fn list_providers(&self) -> Result<Vec<LlmProvider>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, base_url, display_name, json_ext, created_at, updated_at
             FROM llm_providers ORDER BY id"
        )?;
        let rows = stmt.query_map([], row_to_provider)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }


    pub fn delete_provider(&self, id: &str) -> Result<()> {
        let rows = self.conn.execute("DELETE FROM llm_providers WHERE id=?1", params![id])?;
        if rows == 0 {
            return Err(ConfigError::NotFound {
                entity: "llm_providers",
                id: id.into(),
            });
        }
        Ok(())
    }
}

fn row_to_provider(row: &rusqlite::Row) -> std::result::Result<LlmProvider, rusqlite::Error> {
    Ok(LlmProvider {
        id: row.get(0)?,
        kind: row.get(1)?,
        base_url: row.get(2)?,
        display_name: row.get(3)?,
        json_ext: parse_json_or_empty(row.get::<_, String>(4)?),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

// ── LLM Credentials ─────────────────────────────────────────────

impl ProviderStore<'_> {
    pub fn upsert_credential(&self, c: &LlmCredential) -> Result<()> {
        self.conn.execute(
            "INSERT INTO llm_credentials (provider_id, auth_kind, secret_ref, json_ext)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(provider_id) DO UPDATE SET
                auth_kind=excluded.auth_kind, secret_ref=excluded.secret_ref,
                json_ext=excluded.json_ext, updated_at=datetime('now')",
            params![
                c.provider_id,
                c.auth_kind,
                c.secret_ref,
                serde_json::to_string(&c.json_ext).unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    pub fn get_credential(&self, provider_id: &str) -> Result<LlmCredential> {
        self.conn
            .query_row(
                "SELECT provider_id, auth_kind, secret_ref, json_ext, updated_at
                 FROM llm_credentials WHERE provider_id=?1",
                params![provider_id],
                |row| {
                    Ok(LlmCredential {
                        provider_id: row.get(0)?,
                        auth_kind: row.get(1)?,
                        secret_ref: row.get(2)?,
                        json_ext: parse_json_or_empty(row.get::<_, String>(3)?),
                        updated_at: row.get(4)?,
                    })
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ConfigError::NotFound {
                    entity: "llm_credentials",
                    id: provider_id.into(),
                },
                other => ConfigError::Sqlite(other),
            })
    }

    pub fn delete_credential(&self, provider_id: &str) -> Result<()> {
        let rows = self.conn.execute(
            "DELETE FROM llm_credentials WHERE provider_id=?1",
            params![provider_id],
        )?;
        if rows == 0 {
            return Err(ConfigError::NotFound {
                entity: "llm_credentials",
                id: provider_id.into(),
            });
        }
        Ok(())
    }
}

// ── LLM Models (allowlist) ──────────────────────────────────────

impl ProviderStore<'_> {
    pub fn upsert_model(&self, m: &LlmModel) -> Result<()> {
        self.conn.execute(
            "INSERT INTO llm_models (provider_id, model_id, temperature, max_tokens, top_p,
                    thinking_level, extra_body_json, json_ext)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(provider_id, model_id) DO UPDATE SET
                temperature=excluded.temperature,
                max_tokens=excluded.max_tokens,
                top_p=excluded.top_p,
                thinking_level=excluded.thinking_level,
                extra_body_json=excluded.extra_body_json,
                json_ext=excluded.json_ext, updated_at=datetime('now')",
            params![
                m.provider_id,
                m.model_id,
                m.temperature,
                m.max_tokens,
                m.top_p,
                m.thinking_level,
                m.extra_body_json.as_ref().map(|v| v.to_string()),
                serde_json::to_string(&m.json_ext).unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    pub fn get_model(&self, provider_id: &str, model_id: &str) -> Result<LlmModel> {
        self.conn
            .query_row(
                "SELECT provider_id, model_id, temperature, max_tokens, top_p,
                        thinking_level, extra_body_json, json_ext,
                        created_at, updated_at
                 FROM llm_models WHERE provider_id=?1 AND model_id=?2",
                params![provider_id, model_id],
                row_to_model,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ConfigError::NotFound {
                    entity: "llm_models",
                    id: format!("{provider_id}/{model_id}"),
                },
                other => ConfigError::Sqlite(other),
            })
    }

    pub fn list_models(&self, provider_id: &str) -> Result<Vec<LlmModel>> {
        let mut stmt = self.conn.prepare(
            "SELECT provider_id, model_id, temperature, max_tokens, top_p,
                    thinking_level, extra_body_json, json_ext,
                    created_at, updated_at
             FROM llm_models WHERE provider_id=?1 ORDER BY model_id"
        )?;
        let rows = stmt.query_map(params![provider_id], row_to_model)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete_model(&self, provider_id: &str, model_id: &str) -> Result<()> {
        let rows = self.conn.execute(
            "DELETE FROM llm_models WHERE provider_id=?1 AND model_id=?2",
            params![provider_id, model_id],
        )?;
        if rows == 0 {
            return Err(ConfigError::NotFound {
                entity: "llm_models",
                id: format!("{provider_id}/{model_id}"),
            });
        }
        Ok(())
    }
}

fn row_to_model(row: &rusqlite::Row) -> std::result::Result<LlmModel, rusqlite::Error> {
    Ok(LlmModel {
        provider_id: row.get(0)?,
        model_id: row.get(1)?,
        temperature: row.get(2)?,
        max_tokens: row.get(3)?,
        top_p: row.get(4)?,
        thinking_level: row.get(5)?,
        extra_body_json: row.get::<_, Option<String>>(6)?.map(parse_json_or_empty),
        json_ext: parse_json_or_empty(row.get::<_, String>(7)?),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

// ── helpers ─────────────────────────────────────────────────────

pub(crate) fn parse_json_or_empty(s: String) -> serde_json::Value {
    serde_json::from_str(&s).unwrap_or(serde_json::Value::Object(Default::default()))
}
