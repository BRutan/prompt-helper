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
