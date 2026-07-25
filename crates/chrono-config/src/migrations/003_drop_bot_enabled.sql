-- Migration 003: Drop enabled column from bot_profiles

ALTER TABLE bot_profiles DROP COLUMN enabled;
