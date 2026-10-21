// Path: backend/cmd/server/deliveries.go
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prompt-helper/prompt-helper/backend/internal/patch"
)

type prepareDeliveryRequest struct {
	Provider       string `json:"provider"`
	ConversationID string `json:"conversation_id"`
	Filename       string `json:"filename"`
}
type deliveryConfirmRequest struct {
	DeliveryID     string `json:"delivery_id"`
	DiffTokens     int64  `json:"diff_tokens"`
	OriginalTokens int64  `json:"original_tokens"`
	Estimator      string `json:"estimator"`
}
type deliveryRecord struct {
	ID             string            `json:"delivery_id"`
	Provider       string            `json:"provider"`
	ConversationID string            `json:"conversation_id"`
	Status         string            `json:"status"`
	LLMDiff        string            `json:"llm_diff"`
	Files          []batchFileStatus `json:"files"`
	SourceSHA      string            `json:"source_sha256"`
	DiffTokens     *int64            `json:"diff_tokens,omitempty"`
	OriginalTokens *int64            `json:"original_tokens,omitempty"`
	Estimator      *string           `json:"estimator,omitempty"`
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		sendError(w, 415, "Content-Type must be application/json")
		return false
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		sendError(w, 400, "invalid JSON: "+err.Error())
		return false
	}
	var v any
	if err := dec.Decode(&v); !errors.Is(err, io.EOF) {
		sendError(w, 400, "only one JSON object is allowed")
		return false
	}
	return true
}

// Files saved by the streaming upload writer are referenced by a generated
// basename only. The sha256 is checked AGAIN before any delivery confirmation.
func readDeliveryUpload(filename string) (string, error) {
	p, err := uploadPath(env("UPLOAD_DIR", "/data/uploads"), filename)
	if err != nil {
		return "", err
	}
	st, err := os.Lstat(p)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", errors.New("upload is not a regular file")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
func newDeliveryID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (a *app) prepareSessionDelivery(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req prepareDeliveryRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !validChatIdentity(req.Provider, req.ConversationID) {
		sendError(w, 422, "invalid chat identity")
		return
	}
	content, err := readDeliveryUpload(req.Filename)
	if err != nil {
		sendError(w, 422, "cannot load staged upload: "+err.Error())
		return
	}
	sections, err := parseChatSource(content)
	if err != nil || len(sections) == 0 {
		sendError(w, 422, fmt.Sprintf("invalid source: %v", err))
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
	key := req.Provider + ":" + req.ConversationID
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, key); err != nil {
		sendError(w, 503, "lock failed")
		return
	}
	var sid int64
	err = tx.QueryRow(ctx, `INSERT INTO chat_sessions(provider,conversation_id) VALUES ($1,$2) ON CONFLICT(provider,conversation_id) DO UPDATE SET updated_at=chat_sessions.updated_at RETURNING id`, req.Provider, req.ConversationID).Scan(&sid)
	if err != nil {
		sendError(w, 500, "cannot identify session")
		return
	}
	type previous struct {
		sha, content string
		version      int64
	}
	before := map[string]previous{}
	rows, err := tx.Query(ctx, `SELECT path,current_sha256,current_content,version FROM chat_session_files WHERE session_id=$1`, sid)
	if err != nil {
		sendError(w, 500, "cannot read session files")
		return
	}
	for rows.Next() {
		var name string
		var p previous
		if err = rows.Scan(&name, &p.sha, &p.content, &p.version); err != nil {
			break
		}
		before[name] = p
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		sendError(w, 500, "cannot read session snapshot")
		return
	}
	baselines := map[string]string{}
	results := make([]diffResponse, 0, len(sections))
	for _, f := range sections {
		prev, exists := before[f.Path]
		baselines[f.Path] = prev.sha
		h := sourceHash(f.Content)
		item := diffResponse{Path: f.Path, Extension: f.Extension, SHA256: h, Version: prev.version}
		if !exists {
			item.Status = "created"
			item.Version = 1
			item.Result = patch.Initial(f.Path, f.Content)
		} else if prev.sha == h && prev.content == f.Content {
			item.Status = "unchanged"
			item.PreviousSHA256 = prev.sha
			item.Result = patch.Result{Lines: []patch.Line{}}
		} else {
			item.Status = "updated"
			item.Version++
			item.PreviousSHA256 = prev.sha
			item.Result, err = patch.Diff(ctx, f.Path, prev.content, f.Content)
			if err != nil {
				sendError(w, 500, "could not create file diff")
				return
			}
		}
		results = append(results, item)
	}
	preview := composeBatch(results)
	id, err := newDeliveryID()
	if err != nil {
		sendError(w, 500, "cannot create delivery id")
		return
	}
	baseJSON, _ := json.Marshal(baselines)
	manifestJSON, _ := json.Marshal(preview.Files)
	_, err = tx.Exec(ctx, `INSERT INTO chat_session_deliveries(id,session_id,upload_filename,source_sha256,baselines,prepared_diff,manifest) VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, sid, req.Filename, sourceHash(content), baseJSON, preview.LLMDiff, manifestJSON)
	if err != nil {
		log.Printf("prepare delivery: %v", err)
		sendError(w, 500, "cannot stage delivery")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		sendError(w, 500, "cannot commit delivery")
		return
	}
	jsonResponse(w, 200, map[string]any{"delivery_id": id, "session_id": sid, "provider": req.Provider, "conversation_id": req.ConversationID, "source_sha256": sourceHash(content), "status": "prepared", "preview": preview, "upload_bytes": len(content)})
}

// GET loads the SERVER-STORED diff so browser messages cannot substitute a
// different payload. POST confirms a single observed browser submission.
func (a *app) sessionDelivery(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		id := r.URL.Query().Get("delivery_id")
		var rec deliveryRecord
		var manifest []byte
		err := a.db.QueryRow(r.Context(), `SELECT d.id,s.provider,s.conversation_id,d.status,d.prepared_diff,d.manifest,d.source_sha256,d.diff_tokens,d.original_tokens,d.estimator FROM chat_session_deliveries d JOIN chat_sessions s ON s.id=d.session_id WHERE d.id=$1`, id).Scan(&rec.ID, &rec.Provider, &rec.ConversationID, &rec.Status, &rec.LLMDiff, &manifest, &rec.SourceSHA, &rec.DiffTokens, &rec.OriginalTokens, &rec.Estimator)
		if errors.Is(err, pgx.ErrNoRows) {
			sendError(w, 404, "delivery not found")
			return
		}
		if err != nil {
			sendError(w, 500, "cannot read delivery")
			return
		}
		if err = json.Unmarshal(manifest, &rec.Files); err != nil {
			sendError(w, 500, "invalid delivery manifest")
			return
		}
		jsonResponse(w, 200, rec)
	case http.MethodPost:
		var req deliveryConfirmRequest
		if !decodeJSON(w, r, &req) {
			return
		}
		if len(req.DeliveryID) != 32 || req.DiffTokens < 0 || req.OriginalTokens < 0 || req.DiffTokens > 1000000000 || req.OriginalTokens > 1000000000 || len(req.Estimator) > 120 || req.Estimator == "" {
			sendError(w, 422, "invalid confirmation or token estimate")
			return
		}
		a.confirmSessionDelivery(w, r, &req)
	default:
		w.Header().Set("Allow", "GET, POST")
		sendError(w, 405, "method not allowed")
	}
}

// Persist preflight token estimates before a diff is sent to any provider.
func (a *app) sessionDeliveryEstimate(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	var req deliveryConfirmRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.DeliveryID) != 32 || req.DiffTokens < 0 || req.OriginalTokens < 0 || req.DiffTokens > 1000000000 || req.OriginalTokens > 1000000000 || req.Estimator == "" || len(req.Estimator) > 120 {
		sendError(w, 422, "invalid token estimate")
		return
	}
	tag, err := a.db.Exec(r.Context(), `UPDATE chat_session_deliveries SET diff_tokens=$2,original_tokens=$3,estimator=$4 WHERE id=$1 AND status='prepared'`, req.DeliveryID, req.DiffTokens, req.OriginalTokens, req.Estimator)
	if err != nil {
		sendError(w, 500, "cannot save pre-send token estimate")
		return
	}
	if tag.RowsAffected() == 0 {
		sendError(w, 409, "delivery is missing or already sent")
		return
	}
	jsonResponse(w, 200, map[string]any{"delivery_id": req.DeliveryID, "status": "prepared", "diff_tokens": req.DiffTokens, "original_tokens": req.OriginalTokens, "estimator": req.Estimator})
}

func (a *app) confirmSessionDelivery(w http.ResponseWriter, r *http.Request, req *deliveryConfirmRequest) {
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		sendError(w, 503, "database unavailable")
		return
	}
	defer tx.Rollback(context.Background())
	var sid int64
	var filename, expectedSHA, status string
	var baseBytes []byte
	err = tx.QueryRow(ctx, `SELECT session_id,upload_filename,source_sha256,status,baselines FROM chat_session_deliveries WHERE id=$1 FOR UPDATE`, req.DeliveryID).Scan(&sid, &filename, &expectedSHA, &status, &baseBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		sendError(w, 404, "unknown delivery")
		return
	}
	if err != nil {
		sendError(w, 500, "cannot read delivery")
		return
	}
	if status == "sent" {
		jsonResponse(w, 200, map[string]any{"delivery_id": req.DeliveryID, "status": "sent", "idempotent": true})
		return
	}
	var preflightDiff, preflightOriginal int64
	var preflightEstimator string
	err = tx.QueryRow(ctx, `SELECT diff_tokens,original_tokens,estimator FROM chat_session_deliveries WHERE id=$1`, req.DeliveryID).Scan(&preflightDiff, &preflightOriginal, &preflightEstimator)
	if err != nil || preflightDiff != req.DiffTokens || preflightOriginal != req.OriginalTokens || preflightEstimator != req.Estimator {
		sendError(w, 409, "no matching pre-send token estimate was recorded")
		return
	}
	// Locks session across other deliveries, including changes from paste endpoint.
	var provider, conversation string
	err = tx.QueryRow(ctx, `SELECT provider,conversation_id FROM chat_sessions WHERE id=$1`, sid).Scan(&provider, &conversation)
	if err != nil {
		sendError(w, 500, "cannot read session")
		return
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, provider+":"+conversation); err != nil {
		sendError(w, 503, "session lock failed")
		return
	}
	content, err := readDeliveryUpload(filename)
	if err != nil || sourceHash(content) != expectedSHA {
		sendError(w, 409, "staged source no longer matches prepared delivery")
		return
	}
	sections, err := parseChatSource(content)
	if err != nil {
		sendError(w, 409, "staged source no longer parses")
		return
	}
	baseline := map[string]string{}
	if err = json.Unmarshal(baseBytes, &baseline); err != nil {
		sendError(w, 500, "invalid baseline")
		return
	}
	// A prepare based on stale state must NEVER rewind a session's delivered baseline.
	for path, expected := range baseline {
		var current string
		err = tx.QueryRow(ctx, `SELECT current_sha256 FROM chat_session_files WHERE session_id=$1 AND path=$2 FOR UPDATE`, sid, path).Scan(&current)
		if errors.Is(err, pgx.ErrNoRows) {
			current = ""
		} else if err != nil {
			sendError(w, 500, "cannot check session revision")
			return
		}
		if current != expected {
			sendError(w, 409, "session changed since preview; stage again before sending further changes")
			return
		}
	}
	var changed int
	for _, f := range sections {
		item, err := storeSessionFile(ctx, tx, sid, f)
		if err != nil {
			sendError(w, 500, "cannot record delivered file")
			return
		}
		if item.Status == "unchanged" {
			continue
		}
		changed++
		_, err = tx.Exec(ctx, `INSERT INTO chat_session_sent_files(delivery_id,session_id,path,sha256,version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (delivery_id,path) DO UPDATE SET sha256=EXCLUDED.sha256,version=EXCLUDED.version`, req.DeliveryID, sid, item.Path, item.SHA256, item.Version)
		if err != nil {
			sendError(w, 500, "cannot audit sent file")
			return
		}
	}
	cumulative, err := computeSessionDiff(ctx, tx, sid)
	if err != nil {
		sendError(w, 500, "cannot calculate session diff")
		return
	}
	encoded, _ := json.Marshal(cumulative)
	if _, err = tx.Exec(ctx, `UPDATE chat_sessions SET latest_input_sha256=$2,latest_diff=$3,updated_at=now() WHERE id=$1`, sid, expectedSHA, encoded); err != nil {
		sendError(w, 500, "cannot update session")
		return
	}
	_, err = tx.Exec(ctx, `UPDATE chat_session_deliveries SET status='sent',diff_tokens=$2,original_tokens=$3,estimator=$4,sent_at=now() WHERE id=$1`, req.DeliveryID, req.DiffTokens, req.OriginalTokens, req.Estimator)
	if err != nil {
		sendError(w, 500, "cannot record usage")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		sendError(w, 500, "cannot commit sent delivery")
		return
	}
	jsonResponse(w, 200, map[string]any{"delivery_id": req.DeliveryID, "status": "sent", "changed": changed, "diff_tokens": req.DiffTokens, "original_tokens": req.OriginalTokens, "estimator": req.Estimator})
}
func (a *app) sentSessionFiles(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	p, c := r.URL.Query().Get("provider"), r.URL.Query().Get("conversation_id")
	if !validChatIdentity(p, c) {
		sendError(w, 422, "invalid session")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT f.path,f.sha256,f.version,d.id,d.diff_tokens,d.original_tokens,d.estimator,f.sent_at FROM chat_session_sent_files f JOIN chat_session_deliveries d ON d.id=f.delivery_id JOIN chat_sessions s ON s.id=f.session_id WHERE s.provider=$1 AND s.conversation_id=$2 ORDER BY f.sent_at DESC,f.path LIMIT 500`, p, c)
	if err != nil {
		sendError(w, 500, "cannot list sent files")
		return
	}
	defer rows.Close()
	type sent struct {
		Path           string    `json:"path"`
		SHA            string    `json:"sha256"`
		Version        int64     `json:"version"`
		DeliveryID     string    `json:"delivery_id"`
		DiffTokens     *int64    `json:"diff_tokens"`
		OriginalTokens *int64    `json:"original_tokens"`
		Estimator      *string   `json:"estimator"`
		SentAt         time.Time `json:"sent_at"`
	}
	files := make([]sent, 0)
	for rows.Next() {
		var s sent
		if err = rows.Scan(&s.Path, &s.SHA, &s.Version, &s.DeliveryID, &s.DiffTokens, &s.OriginalTokens, &s.Estimator, &s.SentAt); err != nil {
			sendError(w, 500, "cannot read sent files")
			return
		}
		files = append(files, s)
	}
	if rows.Err() != nil {
		sendError(w, 500, "cannot read sent files")
		return
	}
	rows.Close()
	var deliveries, diffTokens, originalTokens int64
	err = a.db.QueryRow(r.Context(), `SELECT COUNT(*),COALESCE(SUM(d.diff_tokens),0),COALESCE(SUM(d.original_tokens),0)
		FROM chat_session_deliveries d JOIN chat_sessions s ON s.id=d.session_id
		WHERE s.provider=$1 AND s.conversation_id=$2 AND d.status='sent'`, p, c).Scan(&deliveries, &diffTokens, &originalTokens)
	if err != nil {
		sendError(w, 500, "cannot read session usage")
		return
	}
	jsonResponse(w, 200, map[string]any{"provider": p, "conversation_id": c, "sent_files": files,
		"usage": map[string]any{"deliveries": deliveries, "estimated_diff_tokens": diffTokens, "estimated_original_tokens": originalTokens}})
}
