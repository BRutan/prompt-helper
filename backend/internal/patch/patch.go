// Package patch shells out to Git's fast native histogram diff engine.
// Go manages bounded inputs and PostgreSQL persistence; no source path is
// accessed on disk. Each diff operates solely on temporary files.
package patch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

type Line struct {
	Kind    string `json:"kind"`
	OldLine *int   `json:"old_line"`
	NewLine *int   `json:"new_line"`
	Text    string `json:"text"`
}

type Result struct {
	Unified   string `json:"unified_diff"`
	LLM       string `json:"llm_diff"`
	Lines     []Line `json:"lines"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

var hunk = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

func ptr(n int) *int { return &n }

func countLines(content string) []string {
	if content == "" {
		return nil
	}
	lines := strings.Split(content, "\n")
	if strings.HasSuffix(content, "\n") {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func Initial(path, text string) Result {
	var r Result
	var output strings.Builder
	fmt.Fprintf(&output, "FILE %s | BASELINE v1 (full content)\n", path)
	for i, line := range countLines(text) {
		r.Lines = append(r.Lines, Line{Kind: "added", NewLine: ptr(i + 1), Text: line})
		fmt.Fprintf(&output, "    %6d + %s\n", i+1, line)
	}
	r.LLM = output.String()
	r.Additions = len(r.Lines)
	return r
}

// Diff returns a context-limited unified diff with original and new line numbers.
// Exit code 1 from git diff means differences were found (not an error).
func Diff(ctx context.Context, filePath, before, after string) (Result, error) {
	dir, err := os.MkdirTemp("", "prompterr-diff-")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(dir)
	oldPath, newPath := dir+"/before", dir+"/after"
	if err := os.WriteFile(oldPath, []byte(before), 0600); err != nil {
		return Result{}, err
	}
	if err := os.WriteFile(newPath, []byte(after), 0600); err != nil {
		return Result{}, err
	}
	cmd := exec.CommandContext(ctx, "git", "-c", "color.ui=false", "--no-pager", "diff",
		"--no-index", "--no-ext-diff", "--text", "--diff-algorithm=histogram", "--unified=3", "--", oldPath, newPath)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_PAGER=cat")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err = cmd.Run()
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
			return Result{}, fmt.Errorf("git diff failed: %w: %s", err, stderr.String())
		}
	}
	raw := strings.Split(stdout.String(), "\n")
	// Ignore machine-specific temporary paths in git's diff header.
	hunkStart := -1
	for i, line := range raw {
		if strings.HasPrefix(line, "@@ ") {
			hunkStart = i
			break
		}
	}
	if hunkStart < 0 {
		if before == after {
			return Result{}, nil
		}
		return Result{}, errors.New("diff output did not contain a hunk")
	}
	hunks := strings.Join(raw[hunkStart:], "\n")
	result := Result{Unified: "--- a/" + filePath + "\n+++ b/" + filePath + "\n" + hunks}
	llm := strings.Builder{}
	fmt.Fprintf(&llm, "FILE %s | CHANGES ONLY | OLD_LINE NEW_LINE +/- TEXT\n", filePath)
	oldNum, newNum := 0, 0
	for _, line := range raw[hunkStart:] {
		if line == "" {
			continue
		} // end-of-output empty line
		if match := hunk.FindStringSubmatch(line); match != nil {
			oldNum, _ = strconv.Atoi(match[1])
			newNum, _ = strconv.Atoi(match[2])
			result.Lines = append(result.Lines, Line{Kind: "hunk", Text: line})
			fmt.Fprintln(&llm, line)
			continue
		}
		if strings.HasPrefix(line, "\\ No newline at end of file") {
			result.Lines = append(result.Lines, Line{Kind: "meta", Text: line})
			fmt.Fprintln(&llm, line)
			continue
		}
		prefix := line[0]
		value := line[1:]
		switch prefix {
		case ' ':
			result.Lines = append(result.Lines, Line{Kind: "context", OldLine: ptr(oldNum), NewLine: ptr(newNum), Text: value})
			fmt.Fprintf(&llm, "%6d %6d   %s\n", oldNum, newNum, value)
			oldNum++
			newNum++
		case '-':
			result.Lines = append(result.Lines, Line{Kind: "removed", OldLine: ptr(oldNum), Text: value})
			fmt.Fprintf(&llm, "%6d        - %s\n", oldNum, value)
			result.Deletions++
			oldNum++
		case '+':
			result.Lines = append(result.Lines, Line{Kind: "added", NewLine: ptr(newNum), Text: value})
			fmt.Fprintf(&llm, "       %6d + %s\n", newNum, value)
			result.Additions++
			newNum++
		}
	}
	result.LLM = llm.String()
	return result, nil
}
