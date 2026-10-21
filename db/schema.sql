-- Path: db/schema.sql
-- prompt-helper v1: immutable baseline, materialized latest, append-only revisions.
CREATE TABLE IF NOT EXISTS files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  extension TEXT NOT NULL,
  initial_content TEXT NOT NULL,
  current_content TEXT NOT NULL,
  current_sha256 CHAR(64) NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_extension_updated_idx
  ON files (extension, updated_at DESC);

CREATE TABLE IF NOT EXISTS file_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version BIGINT NOT NULL CHECK (version >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('initial','diff')),
  previous_sha256 CHAR(64),
  current_sha256 CHAR(64) NOT NULL,
  unified_diff TEXT,
  additions INTEGER NOT NULL DEFAULT 0 CHECK (additions >= 0),
  deletions INTEGER NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, version),
  CHECK ((version = 1 AND kind = 'initial' AND previous_sha256 IS NULL)
      OR (version > 1 AND kind = 'diff' AND previous_sha256 IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS file_revisions_file_version_idx
  ON file_revisions (file_id, version DESC);

-- ChatGPT/Claude conversations have isolated file baselines and one current diff.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('chatgpt', 'claude')),
  conversation_id TEXT NOT NULL,
  latest_input_sha256 CHAR(64),
  latest_diff JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, conversation_id)
);
CREATE TABLE IF NOT EXISTS chat_session_files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  extension TEXT NOT NULL,
  initial_content TEXT NOT NULL,
  current_content TEXT NOT NULL,
  current_sha256 CHAR(64) NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, path)
);
CREATE INDEX IF NOT EXISTS chat_session_files_session_id_idx ON chat_session_files(session_id);

-- Prepared deliveries do not change session baselines until browser delivery is confirmed.
CREATE TABLE IF NOT EXISTS chat_session_deliveries (
  id TEXT PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  upload_filename TEXT NOT NULL,
  source_sha256 CHAR(64) NOT NULL,
  baselines JSONB NOT NULL,
  prepared_diff TEXT NOT NULL,
  prepared_git_diff TEXT NOT NULL DEFAULT '',
  manifest JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','sent')),
  diff_tokens BIGINT,
  original_tokens BIGINT,
  estimator TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS chat_session_deliveries_session_idx ON chat_session_deliveries(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS chat_session_sent_files (
  delivery_id TEXT NOT NULL REFERENCES chat_session_deliveries(id) ON DELETE CASCADE,
  session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  version BIGINT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(delivery_id, path)
);
CREATE INDEX IF NOT EXISTS chat_session_sent_files_session_path_idx ON chat_session_sent_files(session_id, path, sent_at DESC);

-- Response watcher / local patch application audit.
ALTER TABLE chat_session_deliveries ADD COLUMN IF NOT EXISTS prepared_git_diff TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_session_deliveries ADD COLUMN IF NOT EXISTS user_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE chat_session_deliveries ADD COLUMN IF NOT EXISTS response_ms BIGINT;
ALTER TABLE chat_session_deliveries ADD COLUMN IF NOT EXISTS response_completed_at TIMESTAMPTZ;
ALTER TABLE chat_session_deliveries ADD COLUMN IF NOT EXISTS patch_status TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE chat_session_deliveries ADD COLUMN IF NOT EXISTS patch_filename TEXT;
ALTER TABLE chat_session_deliveries ADD COLUMN IF NOT EXISTS patch_details TEXT;
CREATE TABLE IF NOT EXISTS chat_session_patch_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES chat_session_deliveries(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_session_patch_events_delivery_idx ON chat_session_patch_events(delivery_id, created_at DESC);
