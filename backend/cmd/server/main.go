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
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/prompterr/prompterr/backend/internal/header"
	"github.com/prompterr/prompterr/backend/internal/patch"
)

type app struct {
	db       *pgxpool.Pool
	maxBytes int64
}

type diffRequest struct {
	Content string `json:"content"`
}

type diffResponse struct {
	Path           string `json:"path"`
	Extension      string `json:"extension"`
	Status         string `json:"status"`
	Version        int64  `json:"version"`
	PreviousSHA256 string `json:"previous_sha256,omitempty"`
	SHA256         string `json:"sha256"`
	patch.Result
}

func jsonResponse(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func sendError(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]string{"error": message})
}

func requireMethod(w http.ResponseWriter, r *http.Request, wanted string) bool {
	if r.Method == wanted {
		return true
	}
	w.Header().Set("Allow", wanted)
	sendError(w, http.StatusMethodNotAllowed, "method not allowed")
	return false
}

func hash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func (a *app) diff(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		sendError(w, 415, "Content-Type must be application/json")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, a.maxBytes+65536)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var request diffRequest
	if err := dec.Decode(&request); err != nil {
		sendError(w, 400, "invalid JSON or oversized request: "+err.Error())
		return
	}
	// Reject trailing JSON rather than silently ignoring additional requests.
	var trailing any
	if err := dec.Decode(&trailing); err == nil {
		sendError(w, 400, "only one JSON object is allowed")
		return
	} else if !errors.Is(err, io.EOF) {
		sendError(w, 400, "invalid trailing JSON data")
		return
	}
	if int64(len(request.Content)) > a.maxBytes {
		sendError(w, 413, fmt.Sprintf("file exceeds MAX_FILE_BYTES (%d)", a.maxBytes))
		return
	}
	file, err := header.Parse(request.Content)
	if err != nil {
		sendError(w, 422, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		log.Printf("begin: %v", err)
		sendError(w, 503, "database unavailable")
		return
	}
	defer tx.Rollback(context.Background())
	// Serialize same-path writes, including competing first uploads.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, file.Path); err != nil {
		log.Printf("lock: %v", err)
		sendError(w, 500, "cannot lock file")
		return
	}
	var id, version int64
	var before, previousSHA string
	err = tx.QueryRow(ctx, `SELECT id, version, current_content, current_sha256
                            FROM files WHERE path=$1 FOR UPDATE`, file.Path).
		Scan(&id, &version, &before, &previousSHA)
	newSHA := hash(request.Content)
	if errors.Is(err, pgx.ErrNoRows) {
		result := patch.Initial(file.Path, request.Content)
		err = tx.QueryRow(ctx, `INSERT INTO files
            (path, extension, initial_content, current_content, current_sha256, version)
            VALUES ($1,$2,$3,$3,$4,1) RETURNING id`,
			file.Path, file.Extension, request.Content, newSHA).Scan(&id)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO file_revisions
                (file_id,version,kind,current_sha256,additions,deletions)
                VALUES ($1,1,'initial',$2,$3,0)`, id, newSHA, result.Additions)
		}
		if err != nil {
			log.Printf("insert baseline: %v", err)
			sendError(w, 500, "cannot save baseline")
			return
		}
		if err = tx.Commit(ctx); err != nil {
			log.Printf("commit: %v", err)
			sendError(w, 500, "cannot commit baseline")
			return
		}
		jsonResponse(w, 201, diffResponse{Path: file.Path, Extension: file.Extension, Status: "created", Version: 1, SHA256: newSHA, Result: result})
		return
	}
	if err != nil {
		log.Printf("query file: %v", err)
		sendError(w, 500, "cannot look up file")
		return
	}
	if previousSHA == newSHA && before == request.Content {
		jsonResponse(w, 200, diffResponse{Path: file.Path, Extension: file.Extension, Status: "unchanged", Version: version, SHA256: newSHA, PreviousSHA256: previousSHA, Result: patch.Result{Lines: []patch.Line{}}})
		return
	}
	result, err := patch.Diff(ctx, file.Path, before, request.Content)
	if err != nil {
		log.Printf("diff: %v", err)
		sendError(w, 500, "cannot compute diff")
		return
	}
	nextVersion := version + 1
	_, err = tx.Exec(ctx, `UPDATE files
        SET current_content=$2, current_sha256=$3, version=$4, updated_at=now()
        WHERE id=$1`, id, request.Content, newSHA, nextVersion)
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO file_revisions
          (file_id,version,kind,previous_sha256,current_sha256,unified_diff,additions,deletions)
          VALUES ($1,$2,'diff',$3,$4,$5,$6,$7)`,
			id, nextVersion, previousSHA, newSHA, result.Unified, result.Additions, result.Deletions)
	}
	if err != nil {
		log.Printf("save diff: %v", err)
		sendError(w, 500, "cannot persist diff")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		log.Printf("commit: %v", err)
		sendError(w, 500, "cannot commit diff")
		return
	}
	jsonResponse(w, 200, diffResponse{Path: file.Path, Extension: file.Extension, Status: "updated", Version: nextVersion, PreviousSHA256: previousSHA, SHA256: newSHA, Result: result})
}

func (a *app) files(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	limit := 30
	if n := r.URL.Query().Get("limit"); n != "" {
		parsed, err := strconv.Atoi(n)
		if err != nil || parsed < 1 || parsed > 100 {
			sendError(w, 400, "limit must be 1..100")
			return
		}
		limit = parsed
	}
	extension := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("extension")))
	if extension != "" && !strings.HasPrefix(extension, ".") {
		extension = "." + extension
	}
	rows, err := a.db.Query(r.Context(), `SELECT path,extension,version,current_sha256,created_at,updated_at
        FROM files WHERE ($1::text = '' OR extension=$1)
        ORDER BY updated_at DESC LIMIT $2`, extension, limit)
	if err != nil {
		log.Printf("list: %v", err)
		sendError(w, 500, "cannot list files")
		return
	}
	defer rows.Close()
	type item struct {
		Path      string    `json:"path"`
		Extension string    `json:"extension"`
		Version   int64     `json:"version"`
		SHA256    string    `json:"sha256"`
		CreatedAt time.Time `json:"created_at"`
		UpdatedAt time.Time `json:"updated_at"`
	}
	result := make([]item, 0)
	for rows.Next() {
		var value item
		if err := rows.Scan(&value.Path, &value.Extension, &value.Version, &value.SHA256, &value.CreatedAt, &value.UpdatedAt); err != nil {
			sendError(w, 500, "cannot read files")
			return
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		sendError(w, 500, "cannot read files")
		return
	}
	jsonResponse(w, 200, map[string]any{"files": result})
}

func (a *app) history(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		sendError(w, 400, "path is required")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT r.version,r.kind,r.previous_sha256,r.current_sha256,
           r.unified_diff,r.additions,r.deletions,r.created_at
           FROM file_revisions r JOIN files f ON f.id=r.file_id
           WHERE f.path=$1 ORDER BY r.version DESC LIMIT 100`, p)
	if err != nil {
		log.Printf("history: %v", err)
		sendError(w, 500, "cannot read history")
		return
	}
	defer rows.Close()
	type item struct {
		Version        int64     `json:"version"`
		Kind           string    `json:"kind"`
		PreviousSHA256 *string   `json:"previous_sha256"`
		SHA256         string    `json:"sha256"`
		UnifiedDiff    *string   `json:"unified_diff"`
		Additions      int       `json:"additions"`
		Deletions      int       `json:"deletions"`
		CreatedAt      time.Time `json:"created_at"`
	}
	result := make([]item, 0)
	for rows.Next() {
		var v item
		if err := rows.Scan(&v.Version, &v.Kind, &v.PreviousSHA256, &v.SHA256, &v.UnifiedDiff, &v.Additions, &v.Deletions, &v.CreatedAt); err != nil {
			sendError(w, 500, "cannot read history")
			return
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		sendError(w, 500, "cannot read history")
		return
	}
	jsonResponse(w, 200, map[string]any{"path": p, "revisions": result})
}

func (a *app) current(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		sendError(w, 400, "path is required")
		return
	}
	var content, sha, extension string
	var version int64
	err := a.db.QueryRow(r.Context(), `SELECT current_content,current_sha256,extension,version FROM files WHERE path=$1`, p).Scan(&content, &sha, &extension, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		sendError(w, 404, "unknown path")
		return
	}
	if err != nil {
		log.Printf("current: %v", err)
		sendError(w, 500, "cannot load content")
		return
	}
	jsonResponse(w, 200, map[string]any{"path": p, "extension": extension, "version": version, "sha256": sha, "content": content})
}

func env(name, fallback string) string {
	if s := os.Getenv(name); s != "" {
		return s
	}
	return fallback
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		cli := http.Client{Timeout: 2 * time.Second}
		resp, err := cli.Get("http://127.0.0.1:8080/api/v1/health")
		if err != nil {
			os.Exit(1)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	maxBytes, err := strconv.ParseInt(env("MAX_FILE_BYTES", "2097152"), 10, 64)
	if err != nil || maxBytes < 1024 || maxBytes > 32*1024*1024 {
		log.Fatal("MAX_FILE_BYTES must be between 1024 and 33554432")
	}
	dbConfig, err := pgxpool.ParseConfig(fmt.Sprintf("host=%s port=5432 dbname=%s user=%s sslmode=disable",
		env("DB_HOST", "db"), env("DB_NAME", "prompterr"), env("DB_USER", "prompterr")))
	if err != nil {
		log.Fatal(err)
	}
	dbConfig.ConnConfig.Password = env("DB_PASSWORD", "prompterr_dev_only")
	dbConfig.MaxConns = 10
	db, err := pgxpool.NewWithConfig(context.Background(), dbConfig)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	if err := db.Ping(ctx); err != nil {
		cancel()
		log.Fatalf("PostgreSQL unavailable: %v", err)
	}
	cancel()
	a := &app{db: db, maxBytes: maxBytes}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := a.db.Ping(ctx); err != nil {
			sendError(w, 503, "database unavailable")
			return
		}
		jsonResponse(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/api/v1/files/diff", a.diff)
	mux.HandleFunc("/api/v1/files", a.files)
	mux.HandleFunc("/api/v1/files/history", a.history)
	mux.HandleFunc("/api/v1/files/current", a.current)
	addr := env("LISTEN_ADDR", ":8080")
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 60 * time.Second}
	stopCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-stopCtx.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("Prompterr API listening on %s max_file_bytes=%d", addr, maxBytes)
	err = server.ListenAndServe()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
