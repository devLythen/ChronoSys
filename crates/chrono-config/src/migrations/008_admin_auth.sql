-- Migration 008: single-admin WebUI credentials

CREATE TABLE IF NOT EXISTS admin_credentials (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
