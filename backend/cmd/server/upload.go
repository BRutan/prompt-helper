// Path: backend/cmd/server/upload.go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The upload writer creates these basenames; callers never choose a filesystem path.
var uploadedFileName = regexp.MustCompile(`^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{32}\.txt$`)

type processUploadRequest struct {
	Filename string `json:"filename"`
	Path     string `json:"path,omitempty"` // absolute SOURCE_DIR / FILE identity for a split dump
}

func uploadPath(uploadDir, filename string) (string, error) {
	if !uploadedFileName.MatchString(filename) || filepath.Base(filename) != filename {
		return "", errors.New("filename must be a timestamped upload basename, not a path")
	}
	return filepath.Join(uploadDir, filename), nil
}

func (a *app) processUpload(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		sendError(w, 415, "Content-Type must be application/json")
		return
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var request processUploadRequest
	if err := dec.Decode(&request); err != nil {
		sendError(w, 400, "invalid request: "+err.Error())
		return
	}
	var remainder any
	if err := dec.Decode(&remainder); err != io.EOF {
		sendError(w, 400, "only one JSON object is allowed")
		return
	}
	filePath, err := uploadPath(env("UPLOAD_DIR", "/data/uploads"), request.Filename)
	if err != nil {
		sendError(w, 422, err.Error())
		return
	}
	started := time.Now()
	// A symlink cannot be generated through the upload endpoint. Refuse one
	// nevertheless in case the mounted directory was modified from the host.
	info, err := os.Lstat(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			sendError(w, 404, "uploaded file not found on shared mount")
			return
		}
		sendError(w, 500, "cannot inspect mounted upload")
		return
	}
	if !info.Mode().IsRegular() {
		sendError(w, 422, "upload must be an ordinary file")
		return
	}
	bytes, err := os.ReadFile(filePath)
	if err != nil {
		sendError(w, 500, "cannot read mounted upload")
		return
	}
	content := string(bytes)
	file, err := parseUploadedSource(content, request.Path)
	if err != nil {
		sendError(w, 422, err.Error())
		return
	}
	log.Printf("process-upload start filename=%s path=%q bytes=%d", request.Filename, file.Path, len(bytes))

	// Keep a single file in one transaction and finish before nginx's timeout.
	ctx, cancel := context.WithTimeout(r.Context(), 55*time.Second)
	defer cancel()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		log.Printf("process-upload begin: %v", err)
		sendError(w, 503, "database unavailable")
		return
	}
	defer tx.Rollback(context.Background())
	result, err := a.store(ctx, tx, file, content)
	if err != nil {
		log.Printf("process-upload failed filename=%s path=%q elapsed=%s: %v", request.Filename, file.Path, time.Since(started), err)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			sendError(w, 504, "file comparison exceeded 55 seconds; upload was retained in data/uploads for inspection")
		} else {
			sendError(w, 500, "could not process uploaded file: "+err.Error())
		}
		return
	}
	if err = tx.Commit(ctx); err != nil {
		log.Printf("process-upload commit: %v", err)
		sendError(w, 500, "cannot commit uploaded file")
		return
	}
	status := http.StatusOK
	if result.Status == "created" {
		status = http.StatusCreated
	}
	log.Printf("process-upload completed filename=%s path=%q status=%s elapsed=%s", request.Filename, file.Path, result.Status, time.Since(started))
	jsonResponse(w, status, result)
}
