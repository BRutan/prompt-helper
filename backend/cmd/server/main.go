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
	"path"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/prompt-helper/prompt-helper/backend/internal/batch"
	"github.com/prompt-helper/prompt-helper/backend/internal/header"
	"github.com/prompt-helper/prompt-helper/backend/internal/patch"
)

type app struct {
	db *pgxpool.Pool
}

// An explicit absolute path is supplied by the browser only after it has
// parsed a SOURCE_DIR + FILE frame. It takes precedence over any optional
// Path: header in the source. Unframed single-file uploads remain strict.
func parseUploadedSource(content, absolutePath string) (header.File, error) {
	if absolutePath != "" {
		return header.ParseForPath(content, absolutePath)
	}
	return header.Parse(content)
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

// readPayload streams JSON decoding without an application-imposed byte limit.
// PostgreSQL and the host still have physical memory/storage limits.
func readPayload(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		sendError(w, 415, "Content-Type must be application/json")
		return "", false
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var request diffRequest
	if err := dec.Decode(&request); err != nil {
		sendError(w, 400, "invalid JSON request: "+err.Error())
		return "", false
	}
	var trailing any
	if err := dec.Decode(&trailing); err == nil {
		sendError(w, 400, "only one JSON object is allowed")
		return "", false
	} else if !errors.Is(err, io.EOF) {
		sendError(w, 400, "invalid trailing JSON data")
		return "", false
	}
	return request.Content, true
}

// store writes exactly one revision within the caller's transaction. The
// persistent path may be a SOURCE_DIR+FILE absolute path, even if the embedded
// Path header is repo-relative. File content is not rewritten.
func (a *app) store(ctx context.Context, tx pgx.Tx, file header.File, content string) (diffResponse, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, file.Path); err != nil {
		return diffResponse{}, fmt.Errorf("lock %s: %w", file.Path, err)
	}
	var id, version int64
	var before, previousSHA string
	err := tx.QueryRow(ctx, `SELECT id, version, current_content, current_sha256
        FROM files WHERE path=$1 FOR UPDATE`, file.Path).Scan(&id, &version, &before, &previousSHA)
	newSHA := hash(content)
	if errors.Is(err, pgx.ErrNoRows) {
		result := patch.Initial(file.Path, content)
		err = tx.QueryRow(ctx, `INSERT INTO files
            (path, extension, initial_content, current_content, current_sha256, version)
            VALUES ($1,$2,$3,$3,$4,1) RETURNING id`,
			file.Path, file.Extension, content, newSHA).Scan(&id)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO file_revisions
                (file_id,version,kind,current_sha256,additions,deletions)
                VALUES ($1,1,'initial',$2,$3,0)`, id, newSHA, result.Additions)
		}
		if err != nil {
			return diffResponse{}, fmt.Errorf("save baseline %s: %w", file.Path, err)
		}
		return diffResponse{Path: file.Path, Extension: file.Extension, Status: "created", Version: 1, SHA256: newSHA, Result: result}, nil
	}
	if err != nil {
		return diffResponse{}, fmt.Errorf("query file %s: %w", file.Path, err)
	}
	if previousSHA == newSHA && before == content {
		return diffResponse{Path: file.Path, Extension: file.Extension, Status: "unchanged", Version: version,
			SHA256: newSHA, PreviousSHA256: previousSHA, Result: patch.Result{Lines: []patch.Line{}}}, nil
	}
	result, err := patch.Diff(ctx, file.Path, before, content)
	if err != nil {
		return diffResponse{}, fmt.Errorf("diff %s: %w", file.Path, err)
	}
	nextVersion := version + 1
	_, err = tx.Exec(ctx, `UPDATE files
        SET current_content=$2, current_sha256=$3, version=$4, updated_at=now()
        WHERE id=$1`, id, content, newSHA, nextVersion)
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO file_revisions
            (file_id,version,kind,previous_sha256,current_sha256,unified_diff,additions,deletions)
            VALUES ($1,$2,'diff',$3,$4,$5,$6,$7)`,
			id, nextVersion, previousSHA, newSHA, result.Unified, result.Additions, result.Deletions)
	}
	if err != nil {
		return diffResponse{}, fmt.Errorf("save diff %s: %w", file.Path, err)
	}
	return diffResponse{Path: file.Path, Extension: file.Extension, Status: "updated", Version: nextVersion,
		PreviousSHA256: previousSHA, SHA256: newSHA, Result: result}, nil
}

func (a *app) diff(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	content, ok := readPayload(w, r)
	if !ok {
		return
	}
	file, err := header.Parse(content)
	if err != nil {
		sendError(w, 422, err.Error())
		return
	}
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		log.Printf("begin: %v", err)
		sendError(w, 503, "database unavailable")
		return
	}
	defer tx.Rollback(context.Background())
	result, err := a.store(ctx, tx, file, content)
	if err != nil {
		log.Printf("store: %v", err)
		sendError(w, 500, "cannot save file revision")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("commit: %v", err)
		sendError(w, 500, "cannot commit file")
		return
	}
	status := http.StatusOK
	if result.Status == "created" {
		status = http.StatusCreated
	}
	jsonResponse(w, status, result)
}

// The combined response contains one version per file and a full path-preserving
// LLM diff. Unchanged files are omitted from the concatenated changed hunks.
type batchFileStatus struct {
	Path      string `json:"path"`
	Extension string `json:"extension"`
	Status    string `json:"status"`
	Version   int64  `json:"version"`
	SHA256    string `json:"sha256"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

type batchDiffResponse struct {
	Files       []batchFileStatus `json:"files"`
	Total       int               `json:"total"`
	Changed     int               `json:"changed"`
	Unchanged   int               `json:"unchanged"`
	Additions   int               `json:"additions"`
	Deletions   int               `json:"deletions"`
	LLMDiff     string            `json:"llm_diff"`
	UnifiedDiff string            `json:"unified_diff"`
}

func composeBatch(results []diffResponse) batchDiffResponse {
	output := batchDiffResponse{Files: make([]batchFileStatus, 0, len(results)), Total: len(results)}
	var tree, llm, unified strings.Builder
	// Group by actual parent directory while retaining full absolute paths.
	order := make([]int, len(results))
	for i := range results {
		order[i] = i
	}
	sort.Slice(order, func(i, j int) bool { return results[order[i]].Path < results[order[j]].Path })
	fmt.Fprintln(&tree, "SOURCE FILE TREE (absolute paths):")
	lastDir := ""
	for _, idx := range order {
		result := results[idx]
		output.Files = append(output.Files, batchFileStatus{Path: result.Path, Extension: result.Extension, Status: result.Status, Version: result.Version, SHA256: result.SHA256, Additions: result.Additions, Deletions: result.Deletions})
		dir := path.Dir(result.Path)
		if dir != lastDir {
			fmt.Fprintf(&tree, "%s/\n", strings.TrimSuffix(dir, "/"))
			lastDir = dir
		}
		fmt.Fprintf(&tree, "  %s [v%d %s]\n", path.Base(result.Path), result.Version, result.Status)
		output.Additions += result.Additions
		output.Deletions += result.Deletions
		if result.Status == "unchanged" {
			output.Unchanged++
		} else {
			output.Changed++
		}
	}
	fmt.Fprintf(&llm, "BATCH DIFF | %d files | %d changed | %d unchanged\n\n", output.Total, output.Changed, output.Unchanged)
	llm.WriteString(tree.String())
	llm.WriteString("\nCHANGED FILES (old/new line numbers):\n")
	for _, idx := range order {
		result := results[idx]
		if result.Status == "unchanged" {
			continue
		}
		fmt.Fprintf(&llm, "\n=== %s ===\n%sVERSION v%d | SHA256 %s\n", result.Path, result.LLM, result.Version, result.SHA256)
		if result.Unified != "" {
			unified.WriteString(result.Unified)
			unified.WriteByte('\n')
		}
	}
	output.LLMDiff = llm.String()
	output.UnifiedDiff = unified.String()
	return output
}

func (a *app) batchDiff(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	content, ok := readPayload(w, r)
	if !ok {
		return
	}
	files, err := batch.Parse(content)
	if err != nil {
		sendError(w, 422, err.Error())
		return
	}
	// Preserve the original order of repeated paths (A -> B -> A). Acquire
	// unique path locks in sorted order first to prevent inter-batch deadlocks.
	uniquePaths := make(map[string]struct{}, len(files))
	for _, file := range files {
		uniquePaths[file.Path] = struct{}{}
	}
	lockPaths := make([]string, 0, len(uniquePaths))
	for filePath := range uniquePaths {
		lockPaths = append(lockPaths, filePath)
	}
	sort.Strings(lockPaths)
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		log.Printf("batch begin: %v", err)
		sendError(w, 503, "database unavailable")
		return
	}
	defer tx.Rollback(context.Background())
	for _, filePath := range lockPaths {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, filePath); err != nil {
			log.Printf("batch lock path=%q: %v", filePath, err)
			sendError(w, 503, "cannot acquire file lock")
			return
		}
	}
	results := make([]diffResponse, 0, len(files))
	for _, f := range files {
		result, err := a.store(ctx, tx, header.File{Path: f.Path, Extension: f.Extension}, f.Content)
		if err != nil {
			log.Printf("batch store: %v", err)
			sendError(w, 500, "cannot save batch (transaction rolled back)")
			return
		}
		results = append(results, result)
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("batch commit: %v", err)
		sendError(w, 500, "cannot commit batch")
		return
	}
	jsonResponse(w, 200, composeBatch(results))
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
	dbConfig, err := pgxpool.ParseConfig(fmt.Sprintf("host=%s port=5432 dbname=%s user=%s sslmode=disable",
		env("DB_HOST", "db"), env("DB_NAME", "prompt-helper"), env("DB_USER", "prompt-helper")))
	if err != nil {
		log.Fatal(err)
	}
	dbConfig.ConnConfig.Password = env("DB_PASSWORD", "prompt-helper_dev_only")
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
	if err := ensureChatSessionSchema(context.Background(), db); err != nil {
		log.Fatalf("chat session migration failed: %v", err)
	}
	a := &app{db: db}
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
	mux.HandleFunc("/api/v1/files/process-upload", a.processUpload)
	mux.HandleFunc("/api/v1/files/diff", a.diff)
	mux.HandleFunc("/api/v1/chat-sessions/diff", a.chatSessionDiff)
	mux.HandleFunc("/api/v1/chat-sessions/prepare", a.prepareSessionDelivery)
	mux.HandleFunc("/api/v1/chat-sessions/delivery", a.sessionDelivery)
	mux.HandleFunc("/api/v1/chat-sessions/delivery/estimate", a.sessionDeliveryEstimate)
	mux.HandleFunc("/api/v1/chat-sessions/sent-files", a.sentSessionFiles)
	mux.HandleFunc("/api/v1/chat-sessions/patch-event", a.sessionPatchEvent)
	mux.HandleFunc("/api/v1/files/batch-diff", a.batchDiff)
	mux.HandleFunc("/api/v1/files", a.files)
	mux.HandleFunc("/api/v1/files/history", a.history)
	mux.HandleFunc("/api/v1/files/current", a.current)
	addr := env("LISTEN_ADDR", ":8080")
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 120 * time.Second}
	stopCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-stopCtx.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("prompt-helper API listening on %s (no application-level body-size cap)", addr)
	err = server.ListenAndServe()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
