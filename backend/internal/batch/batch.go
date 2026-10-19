// Package batch parses annotated multi-file source dumps without reading the
// referenced paths on the server's filesystem.
package batch

import (
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/prompt-helper/prompt-helper/backend/internal/header"
)

// Section is a single validated source file extracted from a combined paste.
type Section struct {
	Path      string
	Extension string
	Content   string
}

// A block starts only at a full separator + SOURCE_DIR + FILE + separator.
// This avoids accidentally splitting on code lines mentioning FILE:.
var block = regexp.MustCompile(`(?m)^={8,}\r?\nSOURCE_DIR:[ \t]*([^\r\n]+)\r?\nFILE:[ \t]*([^\r\n]+)\r?\n={8,}\r?\n`)

// IsBatch detects an actual file section (not a prose mention of SOURCE_DIR).
func IsBatch(content string) bool { return block.MatchString(content) }

// Parse checks every section and its embedded Path comment before any writes.
// For an annotated relative path, the SOURCE_DIR + FILE absolute path is used
// as the persistent record identity, while source file bytes stay unchanged.
func Parse(content string) ([]Section, error) {
	matches := block.FindAllStringSubmatchIndex(content, -1)
	if len(matches) == 0 {
		return nil, fmt.Errorf("no SOURCE_DIR / FILE sections found")
	}

	output := make([]Section, 0, len(matches))
	seen := make(map[string]bool, len(matches))
	for i, match := range matches {
		dir := strings.TrimSpace(content[match[2]:match[3]])
		name := strings.TrimSpace(content[match[4]:match[5]])
		if !path.IsAbs(dir) || path.Clean(dir) != dir || strings.ContainsAny(dir, "\\\x00") || strings.Contains(dir, "://") {
			return nil, fmt.Errorf("section %d: SOURCE_DIR must be a clean absolute directory: %q", i+1, dir)
		}
		if name == "" || path.IsAbs(name) || path.Clean(name) != name || name == "." || name == ".." ||
			strings.HasPrefix(name, "../") || strings.ContainsAny(name, "\\\x00") || strings.Contains(name, "://") {
			return nil, fmt.Errorf("section %d: FILE must be a clean relative filepath: %q", i+1, name)
		}
		fullPath := path.Join(dir, name)
		if seen[fullPath] {
			return nil, fmt.Errorf("duplicate file in batch: %s", fullPath)
		}
		seen[fullPath] = true
		end := len(content)
		if i+1 < len(matches) {
			end = matches[i+1][0]
		}
		body := content[match[1]:end]
		// Source dumps put one empty line between the closing header separator
		// and source, plus empty lines before the next opening separator.
		body = strings.TrimPrefix(body, "\r\n")
		body = strings.TrimPrefix(body, "\n")
		// Remove separator-only trailing blank lines; keep a terminal LF.
		body = strings.TrimRight(body, "\r\n") + "\n"
		// The frame is the source of truth; Path: is optional or advisory.
		annotated, err := header.ParseForPath(body, fullPath)
		if err != nil {
			return nil, fmt.Errorf("section %d (%s): %w", i+1, fullPath, err)
		}
		output = append(output, Section{Path: fullPath, Extension: annotated.Extension, Content: body})
	}
	return output, nil
}
