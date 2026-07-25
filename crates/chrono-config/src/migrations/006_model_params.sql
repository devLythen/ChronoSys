ALTER TABLE llm_models ADD COLUMN temperature REAL;
ALTER TABLE llm_models ADD COLUMN max_tokens INTEGER;
ALTER TABLE llm_models ADD COLUMN top_p REAL;
ALTER TABLE llm_models ADD COLUMN thinking_level TEXT;
