/**
 * Persistent conversation transcripts under $CHRONO_HOME/state/sessions.db.
 *
 * Model:
 * - route_key  = deterministic routing key: {session_key}#{bot_profile_id}
 * - session_id = random UUID per conversation instance
 * - active_sessions[route_key] → current session_id
 * - /new allocates a new UUID and repoints active_sessions
 *
 * Each dialogue turn:
 *   resolve active session for route → load messages → prompt → save messages
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type SessionRecord = {
  sessionId: string;
  routeKey: string;
  sessionKey: string;
  botProfileId: string;
  messages: AgentMessage[];
  lastDate: string;
  createdAt: string;
  updatedAt: string;
};

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  session_id      TEXT PRIMARY KEY,
  route_key       TEXT NOT NULL,
  session_key     TEXT NOT NULL,
  bot_profile_id  TEXT NOT NULL,
  messages_json   TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_date       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_conv_sessions_route
  ON conversation_sessions(route_key);
CREATE INDEX IF NOT EXISTS idx_conv_sessions_session_key
  ON conversation_sessions(session_key);

CREATE TABLE IF NOT EXISTS active_sessions (
  route_key   TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES conversation_sessions(session_id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** v2: UUID sessions + active pointer (replaces generation model). */
const MIGRATION_002 = `
-- Drop legacy generation-based table if present (dev-stage; no user migration).
DROP TABLE IF EXISTS conversation_sessions;
DROP TABLE IF EXISTS active_sessions;

CREATE TABLE conversation_sessions (
  session_id      TEXT PRIMARY KEY,
  route_key       TEXT NOT NULL,
  session_key     TEXT NOT NULL,
  bot_profile_id  TEXT NOT NULL,
  messages_json   TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_sessions_route
  ON conversation_sessions(route_key);
CREATE INDEX IF NOT EXISTS idx_conv_sessions_session_key
  ON conversation_sessions(session_key);

CREATE TABLE active_sessions (
  route_key   TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES conversation_sessions(session_id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** v3: track last message date per session for date-separator injection. */
const MIGRATION_003 = `
ALTER TABLE conversation_sessions ADD COLUMN last_date TEXT NOT NULL DEFAULT '';
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
    if (row.v < 2) {
      this.db.run(MIGRATION_002);
      this.db.run(
        "INSERT INTO schema_migrations (version, name) VALUES (2, '002_uuid_sessions')",
      );
    }
    if (row.v < 3) {
      this.db.run(MIGRATION_003);
      this.db.run(
        "INSERT INTO schema_migrations (version, name) VALUES (3, '003_last_date')",
      );
    }
  }

  /**
   * Resolve the active session for a route, creating a new UUID session if none.
   */
  getOrCreateActive(
    routeKey: string,
    sessionKey: string,
    botProfileId: string,
  ): SessionRecord {
    const active = this.db
      .query(`SELECT session_id FROM active_sessions WHERE route_key = ?`)
      .get(routeKey) as { session_id: string } | null;

    if (active) {
      const rec = this.loadById(active.session_id);
      if (rec) return rec;
      // Dangling pointer — create fresh.
    }

    return this.createSession(routeKey, sessionKey, botProfileId);
  }

  loadById(sessionId: string): SessionRecord | null {
    const row = this.db
      .query(
        `SELECT session_id, route_key, session_key, bot_profile_id,
                messages_json, last_date, created_at, updated_at
         FROM conversation_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          session_id: string;
          route_key: string;
          session_key: string;
          bot_profile_id: string;
          messages_json: string;
          created_at: string;
          last_date: string;
          updated_at: string;
        }
      | null;

    if (!row) return null;
    return {
      sessionId: row.session_id,
      routeKey: row.route_key,
      sessionKey: row.session_key,
      botProfileId: row.bot_profile_id,
      lastDate: row.last_date,
      messages: parseMessages(row.messages_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Persist messages + last_date for an existing session_id. */
  save(sessionId: string, messages: AgentMessage[], lastDate: string): void {
    this.db.run(
      `UPDATE conversation_sessions
       SET messages_json = ?, last_date = ?, updated_at = datetime('now')
       WHERE session_id = ?`,
      [JSON.stringify(messages), lastDate, sessionId],
    );
  }

  /**
   * /new: allocate a new UUID session and repoint active_sessions.
   * Previous session row is kept (history archive).
   */
  rotate(
    routeKey: string,
    sessionKey: string,
    botProfileId: string,
  ): SessionRecord {
    return this.createSession(routeKey, sessionKey, botProfileId);
  }

  private createSession(
    routeKey: string,
    sessionKey: string,
    botProfileId: string,
  ): SessionRecord {
    const sessionId = randomUUID();
    this.db.run(
      `INSERT INTO conversation_sessions
         (session_id, route_key, session_key, bot_profile_id, messages_json)
       VALUES (?, ?, ?, ?, '[]')`,
      [sessionId, routeKey, sessionKey, botProfileId],
    );
    this.db.run(
      `INSERT INTO active_sessions (route_key, session_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(route_key) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = datetime('now')`,
      [routeKey, sessionId],
    );
    return {
      sessionId,
      routeKey,
      sessionKey,
      botProfileId,
      messages: [],
      lastDate: "",
      createdAt: "",
      updatedAt: "",
    };
  }
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

export function routeKey(sessionKey: string, botId: string): string {
  return `${sessionKey}#${botId}`;
}
