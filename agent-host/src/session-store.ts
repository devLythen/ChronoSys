/**
 * Persistent conversation transcripts under $CHRONO_HOME/state/sessions.db.
 *
 * Isolation key (logical_key):
 *   {session_key}#{bot_profile_id}
 * Active generation is stored per logical_key; /new bumps generation and
 * starts a fresh empty messages blob.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type SessionRecord = {
  logicalKey: string;
  sessionKey: string;
  botProfileId: string;
  generation: number;
  messages: AgentMessage[];
  updatedAt: string;
};

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  logical_key     TEXT PRIMARY KEY,
  session_key     TEXT NOT NULL,
  bot_profile_id  TEXT NOT NULL,
  generation      INTEGER NOT NULL DEFAULT 0,
  messages_json   TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_sessions_session
  ON conversation_sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_conv_sessions_bot
  ON conversation_sessions(bot_profile_id);
`;

export class SessionStore {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        name TEXT NOT NULL
      );
    `);
    const row = this.db
      .query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
      .get() as { v: number };
    if (row.v < 1) {
      this.db.run(MIGRATION_001);
      this.db.run(
        "INSERT INTO schema_migrations (version, name) VALUES (1, '001_sessions')",
      );
    }
  }

  /** Load active session bucket; returns empty messages if none. */
  load(logicalKey: string): SessionRecord {
    const row = this.db
      .query(
        `SELECT logical_key, session_key, bot_profile_id, generation, messages_json, updated_at
         FROM conversation_sessions WHERE logical_key = ?`,
      )
      .get(logicalKey) as
      | {
          logical_key: string;
          session_key: string;
          bot_profile_id: string;
          generation: number;
          messages_json: string;
          updated_at: string;
        }
      | null;

    if (!row) {
      const [sessionKey, botProfileId] = splitLogical(logicalKey);
      return {
        logicalKey,
        sessionKey,
        botProfileId,
        generation: 0,
        messages: [],
        updatedAt: "",
      };
    }

    return {
      logicalKey: row.logical_key,
      sessionKey: row.session_key,
      botProfileId: row.bot_profile_id,
      generation: row.generation,
      messages: parseMessages(row.messages_json),
      updatedAt: row.updated_at,
    };
  }

  /** Upsert transcript for the active generation. */
  save(
    logicalKey: string,
    sessionKey: string,
    botProfileId: string,
    generation: number,
    messages: AgentMessage[],
  ): void {
    const messagesJson = JSON.stringify(messages);
    this.db.run(
      `INSERT INTO conversation_sessions
         (logical_key, session_key, bot_profile_id, generation, messages_json, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(logical_key) DO UPDATE SET
         generation = excluded.generation,
         messages_json = excluded.messages_json,
         updated_at = datetime('now')`,
      [logicalKey, sessionKey, botProfileId, generation, messagesJson],
    );
  }

  /**
   * Rotate to a new generation: bump counter, clear messages.
   * Returns the new generation number.
   */
  rotate(
    logicalKey: string,
    sessionKey: string,
    botProfileId: string,
  ): number {
    const current = this.load(logicalKey);
    const next = current.generation + 1;
    this.save(logicalKey, sessionKey, botProfileId, next, []);
    return next;
  }
}

function splitLogical(logicalKey: string): [string, string] {
  const idx = logicalKey.lastIndexOf("#");
  if (idx <= 0) return [logicalKey, ""];
  return [logicalKey.slice(0, idx), logicalKey.slice(idx + 1)];
}

function parseMessages(raw: string): AgentMessage[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AgentMessage[]) : [];
  } catch {
    return [];
  }
}

export function sessionsDbPath(chronoHome: string): string {
  return `${chronoHome}/state/sessions.db`;
}
