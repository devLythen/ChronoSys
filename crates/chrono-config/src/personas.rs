use rusqlite::{params, Connection};

use crate::models::Persona;
use crate::store::{ConfigError, Result};
use crate::providers::parse_json_or_empty;

pub struct PersonaStore<'a> {
    pub(crate) conn: &'a Connection,
}

impl PersonaStore<'_> {
    pub fn insert(&self, p: &Persona) -> Result<()> {
        self.conn.execute(
            "INSERT INTO personas (id, display_name, system_prompt, tools_allowlist_json,
                    skills_allowlist_json, json_ext)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                p.id,
                p.display_name,
                p.system_prompt,
                serde_json::to_string(&p.tools_allowlist_json).unwrap_or_default(),
                serde_json::to_string(&p.skills_allowlist_json).unwrap_or_default(),
                serde_json::to_string(&p.json_ext).unwrap_or_default(),
            ],
        )?;
        Ok(())
    }

    pub fn update(&self, p: &Persona) -> Result<()> {
        let rows = self.conn.execute(
            "UPDATE personas SET display_name=?2, system_prompt=?3, tools_allowlist_json=?4,
                    skills_allowlist_json=?5, json_ext=?6, updated_at=datetime('now')
             WHERE id=?1",
            params![
                p.id,
                p.display_name,
                p.system_prompt,
                serde_json::to_string(&p.tools_allowlist_json).unwrap_or_default(),
                serde_json::to_string(&p.skills_allowlist_json).unwrap_or_default(),
                serde_json::to_string(&p.json_ext).unwrap_or_default(),
            ],
        )?;
        if rows == 0 {
            return Err(ConfigError::NotFound { entity: "personas", id: p.id.clone() });
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Persona> {
        self.conn
            .query_row(
                "SELECT id, display_name, system_prompt, tools_allowlist_json,
                        skills_allowlist_json, json_ext, created_at, updated_at
                 FROM personas WHERE id=?1",
                params![id],
                row_to_persona,
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ConfigError::NotFound {
                    entity: "personas",
                    id: id.into(),
                },
                other => ConfigError::Sqlite(other),
            })
    }

    pub fn list(&self) -> Result<Vec<Persona>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, display_name, system_prompt, tools_allowlist_json,
                    skills_allowlist_json, json_ext, created_at, updated_at
             FROM personas ORDER BY id"
        )?;
        let rows = stmt.query_map([], row_to_persona)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let rows = self.conn.execute("DELETE FROM personas WHERE id=?1", params![id])?;
        if rows == 0 {
            return Err(ConfigError::NotFound {
                entity: "personas",
                id: id.into(),
            });
        }
        Ok(())
    }
}

fn row_to_persona(row: &rusqlite::Row) -> std::result::Result<Persona, rusqlite::Error> {
    Ok(Persona {
        id: row.get(0)?,
        display_name: row.get(1)?,
        system_prompt: row.get(2)?,
        tools_allowlist_json: parse_json_or_empty(row.get::<_, String>(3)?),
        skills_allowlist_json: parse_json_or_empty(row.get::<_, String>(4)?),
        json_ext: parse_json_or_empty(row.get::<_, String>(5)?),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
