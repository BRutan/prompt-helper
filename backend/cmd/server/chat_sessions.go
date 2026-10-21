// Path: backend/cmd/server/chat_sessions.go
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prompt-helper/prompt-helper/backend/internal/batch"
	"github.com/prompt-helper/prompt-helper/backend/internal/header"
	"github.com/prompt-helper/prompt-helper/backend/internal/patch"
)

// These tables deliberately do not reuse the global files table. One chat
// conversation has one independent baseline per file and ONE latest session diff.
const chatSessionSchema = `
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
CREATE TABLE IF NOT EXISTS chat_session_deliveries (
  id TEXT PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  upload_filename TEXT NOT NULL,
  source_sha256 CHAR(64) NOT NULL,
  baselines JSONB NOT NULL,
  prepared_diff TEXT NOT NULL,
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
`

// Existing Postgres volumes do not rerun docker-entrypoint-initdb.d. Bootstrap
// this additive schema on service startup as well as in db/schema.sql.
func ensureChatSessionSchema(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('prompt-helper.chat-sessions.schema'))`); err != nil {
		return err
	}
	for _, statement := range strings.Split(chatSessionSchema, ";") {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		if _, err = tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("chat session schema: %w", err)
		}
	}
	return tx.Commit(ctx)
}

var conversationIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`)

type chatDiffRequest struct {
	Provider       string `json:"provider"`
	ConversationID string `json:"conversation_id"`
	Content        string `json:"content"`
}

type chatDiffResponse struct {
	Provider       string `json:"provider"`
	ConversationID string `json:"conversation_id"`
	SessionID      int64  `json:"session_id"`
	Status         string `json:"status"`
	// Incremental changes for this individual pasted input: use this in chat.
	batchDiffResponse
	// One materialized, cumulative session diff, keyed by conversation.
	SessionDiff batchDiffResponse `json:"session_diff"`
}

func validChatIdentity(provider, conversationID string) bool {
	return (provider == "chatgpt" || provider == "claude") && conversationIDPattern.MatchString(conversationID)
}

func parseChatSource(content string) ([]batch.Section, error) {
	if batch.IsBatch(content) {
		return batch.Parse(content)
	}
	f, err := header.Parse(content)
	if err != nil {
		return nil, err
	}
	return []batch.Section{{Path: f.Path, Extension: f.Extension, Content: content}}, nil
}

func sourceHash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// sessionFileState provides both incremental and initial-baseline comparisons.
func storeSessionFile(ctx context.Context, tx pgx.Tx, sessionID int64, f batch.Section) (diffResponse, error) {
	var version int64
	var previous, previousSHA string
	err := tx.QueryRow(ctx, `SELECT version, current_content, current_sha256
        FROM chat_session_files WHERE session_id=$1 AND path=$2 FOR UPDATE`, sessionID, f.Path).
		Scan(&version, &previous, &previousSHA)
	currentSHA := sourceHash(f.Content)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO chat_session_files
            (session_id,path,extension,initial_content,current_content,current_sha256)
            VALUES ($1,$2,$3,$4,$4,$5)`, sessionID, f.Path, f.Extension, f.Content, currentSHA)
		if err != nil {
			return diffResponse{}, err
		}
		return diffResponse{Path: f.Path, Extension: f.Extension, Status: "created", Version: 1,
			SHA256: currentSHA, Result: patch.Initial(f.Path, f.Content)}, nil
	}
	if err != nil {
		return diffResponse{}, err
	}
	if previousSHA == currentSHA && previous == f.Content {
		return diffResponse{Path: f.Path, Extension: f.Extension, Status: "unchanged", Version: version,
			SHA256: currentSHA, PreviousSHA256: previousSHA, Result: patch.Result{Lines: []patch.Line{}}}, nil
	}
	result, err := patch.Diff(ctx, f.Path, previous, f.Content)
	if err != nil {
		return diffResponse{}, err
	}
	version++
	_, err = tx.Exec(ctx, `UPDATE chat_session_files SET current_content=$3,current_sha256=$4,
        version=$5,updated_at=now() WHERE session_id=$1 AND path=$2`, sessionID, f.Path,
		f.Content, currentSHA, version)
	if err != nil {
		return diffResponse{}, err
	}
	return diffResponse{Path: f.Path, Extension: f.Extension, Status: "updated", Version: version,
		SHA256: currentSHA, PreviousSHA256: previousSHA, Result: result}, nil
}

func computeSessionDiff(ctx context.Context, tx pgx.Tx, sessionID int64) (batchDiffResponse, error) {
	rows, err := tx.Query(ctx, `SELECT path,extension,initial_content,current_content,current_sha256,version
        FROM chat_session_files WHERE session_id=$1 ORDER BY path`, sessionID)
	if err != nil {
		return batchDiffResponse{}, err
	}
	type snapshot struct {
		path, extension, initial, current, sha string
		version                                int64
	}
	all := make([]snapshot, 0)
	for rows.Next() {
		var v snapshot
		if err = rows.Scan(&v.path, &v.extension, &v.initial, &v.current, &v.sha, &v.version); err != nil {
			break
		}
		all = append(all, v)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return batchDiffResponse{}, err
	}
	results := make([]diffResponse, 0, len(all))
	for _, f := range all {
		r := diffResponse{Path: f.path, Extension: f.extension, Version: f.version, SHA256: f.sha}
		if f.version == 1 {
			r.Status = "created"
			r.Result = patch.Initial(f.path, f.current)
		} else {
			r.Status = "updated"
			r.Result, err = patch.Diff(ctx, f.path, f.initial, f.current)
			if err != nil {
				return batchDiffResponse{}, err
			}
			if f.initial == f.current {
				r.Status = "unchanged"
				r.Result = patch.Result{Lines: []patch.Line{}}
			}
		}
		results = append(results, r)
	}
	return composeBatch(results), nil
}

func (a *app) chatSessionDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		provider, conversationID := r.URL.Query().Get("provider"), r.URL.Query().Get("conversation_id")
		if !validChatIdentity(provider, conversationID) {
			sendError(w, 400, "invalid provider or conversation_id")
			return
		}
		var payload []byte
		err := a.db.QueryRow(r.Context(), `SELECT latest_diff FROM chat_sessions WHERE provider=$1 AND conversation_id=$2`,
			provider, conversationID).Scan(&payload)
		if errors.Is(err, pgx.ErrNoRows) {
			sendError(w, 404, "conversation session not found")
			return
		}
		if err != nil {
			log.Printf("chat session lookup: %v", err)
			sendError(w, 500, "cannot read session")
			return
		}
		var diff batchDiffResponse
		if err := json.Unmarshal(payload, &diff); err != nil {
			sendError(w, 500, "invalid stored session diff")
			return
		}
		jsonResponse(w, 200, map[string]any{"provider": provider, "conversation_id": conversationID, "session_diff": diff})
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		sendError(w, 415, "Content-Type must be application/json")
		return
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var req chatDiffRequest
	if err := decoder.Decode(&req); err != nil {
		sendError(w, 400, "invalid JSON: "+err.Error())
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		sendError(w, 400, "only one JSON object is allowed")
		return
	}
	if !validChatIdentity(req.Provider, req.ConversationID) {
		sendError(w, 422, "provider must be chatgpt/claude and conversation_id must be a clean identifier")
		return
	}
	files, err := parseChatSource(req.Content)
	if err != nil {
		sendError(w, 422, "source format: "+err.Error())
		return
	}
	if len(files) == 0 {
		sendError(w, 422, "no source files found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		sendError(w, 503, "database unavailable")
		return
	}
	defer tx.Rollback(context.Background())
	// Session-level advisory lock serializes concurrent source pastes for one
	// conversation, including initial INSERT, making snapshots deterministic.
	key := req.Provider + ":" + req.ConversationID
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, key); err != nil {
		sendError(w, 503, "session lock failed")
		return
	}
	var sessionID int64
	err = tx.QueryRow(ctx, `INSERT INTO chat_sessions (provider,conversation_id) VALUES($1,$2)
        ON CONFLICT (provider,conversation_id) DO UPDATE SET updated_at=chat_sessions.updated_at
        RETURNING id`, req.Provider, req.ConversationID).Scan(&sessionID)
	if err != nil {
		log.Printf("chat session create: %v", err)
		sendError(w, 500, "session creation failed")
		return
	}
	results := make([]diffResponse, 0, len(files))
	for _, f := range files {
		result, err := storeSessionFile(ctx, tx, sessionID, f)
		if err != nil {
			log.Printf("chat session store: %v", err)
			sendError(w, 500, "session update failed")
			return
		}
		results = append(results, result)
	}
	incremental := composeBatch(results)
	cumulative, err := computeSessionDiff(ctx, tx, sessionID)
	if err != nil {
		log.Printf("chat session cumulative: %v", err)
		sendError(w, 500, "session diff failed")
		return
	}
	encoded, err := json.Marshal(cumulative)
	if err != nil {
		sendError(w, 500, "cannot encode session diff")
		return
	}
	_, err = tx.Exec(ctx, `UPDATE chat_sessions SET latest_input_sha256=$2,latest_diff=$3,updated_at=now() WHERE id=$1`,
		sessionID, sourceHash(req.Content), encoded)
	if err != nil {
		log.Printf("chat session save: %v", err)
		sendError(w, 500, "cannot save session diff")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("chat session commit: %v", err)
		sendError(w, 500, "cannot commit session diff")
		return
	}
	status := "updated"
	if incremental.Changed == 0 {
		status = "unchanged"
	}
	jsonResponse(w, 200, chatDiffResponse{Provider: req.Provider, ConversationID: req.ConversationID,
		SessionID: sessionID, Status: status, batchDiffResponse: incremental, SessionDiff: cumulative})
}
