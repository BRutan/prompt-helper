// Package header checks extension-specific Path comments or a bare Path line.
// It never reads or writes the user-supplied path on the host filesystem.
package header

import (
	"errors"
	"fmt"
	"path"
	"strings"
	"unicode/utf8"
)

type File struct {
	Path      string
	Extension string
}

type comment struct{ open, close string }

var comments = map[string]comment{
	".ts": {"//", ""}, ".tsx": {"//", ""}, ".js": {"//", ""}, ".jsx": {"//", ""},
	".mjs": {"//", ""}, ".cjs": {"//", ""}, ".go": {"//", ""},
	".rs": {"//", ""}, ".swift": {"//", ""}, ".java": {"//", ""},
	".c": {"//", ""}, ".cc": {"//", ""}, ".cpp": {"//", ""}, ".h": {"//", ""},
	".hpp": {"//", ""}, ".cs": {"//", ""}, ".kt": {"//", ""},
	".kts": {"//", ""}, ".scala": {"//", ""}, ".php": {"//", ""},
	".proto": {"//", ""}, ".jsonc": {"//", ""},
	".py": {"#", ""}, ".rb": {"#", ""}, ".sh": {"#", ""},
	".bash": {"#", ""}, ".zsh": {"#", ""}, ".yml": {"#", ""},
	".yaml": {"#", ""}, ".toml": {"#", ""}, ".ini": {"#", ""},
	".cfg": {"#", ""}, ".conf": {"#", ""}, ".mk": {"#", ""},
	".tf": {"#", ""}, ".tfvars": {"#", ""}, ".graphql": {"#", ""},
	".sql": {"--", ""}, ".lua": {"--", ""}, ".hs": {"--", ""},
	".css": {"/*", "*/"}, ".scss": {"/*", "*/"}, ".less": {"/*", "*/"},
	".html": {"<!--", "-->"}, ".htm": {"<!--", "-->"},
	".xml": {"<!--", "-->"}, ".svg": {"<!--", "-->"},
	".md": {"<!--", "-->"}, ".mdx": {"<!--", "-->"},
	".vue": {"<!--", "-->"},
}

func extension(filePath string) string {
	base := path.Base(filePath)
	lower := strings.ToLower(base)
	switch {
	case lower == "makefile", lower == "gnumakefile", strings.HasPrefix(lower, "dockerfile"):
		return ".mk"
	case lower == ".env", strings.HasPrefix(lower, ".env."):
		return ".env"
	case lower == ".gitignore", lower == ".dockerignore":
		return ".gitignore"
	}
	return strings.ToLower(path.Ext(lower))
}

func Parse(content string) (File, error) {
	if !utf8.ValidString(content) || strings.ContainsRune(content, '\x00') {
		return File{}, errors.New("file must be UTF-8 text without NUL bytes")
	}
	normalized := strings.TrimPrefix(content, "\ufeff")
	// A Path: header may appear after a pasted banner, blank lines or a code
	// fence. Match only a complete line, never a mid-line string literal.
	first := ""
	for remaining := normalized; len(remaining) > 0; {
		line := remaining
		if newline := strings.IndexByte(remaining, '\n'); newline >= 0 {
			line, remaining = remaining[:newline], remaining[newline+1:]
		} else {
			remaining = ""
		}
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Path:") {
			first = line
			break
		}
		for _, prefix := range []string{"<!--", "/*", "//", "--", "#"} {
			if !strings.HasPrefix(line, prefix) {
				continue
			}
			rest := line[len(prefix):]
			if len(rest) > 0 && (rest[0] == ' ' || rest[0] == '\t') &&
				strings.HasPrefix(strings.TrimLeft(rest, " \t"), "Path:") {
				first = line
				break
			}
		}
		if first != "" {
			break
		}
	}
	// Use the longest matching comment leader. Handle JS/CSS/HTML safely.
	candidates := []comment{
		{"<!--", "-->"}, {"/*", "*/"}, {"//", ""}, {"--", ""}, {"#", ""},
	}
	var rawPath string
	var leader comment
	found := false
	// Plain Path: is accepted in addition to extension-specific comment
	// headers. The stored bytes remain untouched; only metadata is parsed.
	plain := false
	if strings.HasPrefix(first, "Path:") && len(first) > len("Path:") &&
		(first[len("Path:")] == ' ' || first[len("Path:")] == '\t') {
		rawPath = strings.TrimSpace(first[len("Path:"):])
		plain, found = true, true
	}
	for _, c := range candidates {
		if !strings.HasPrefix(first, c.open) {
			continue
		}
		rest := first[len(c.open):]
		if len(rest) == 0 || (rest[0] != ' ' && rest[0] != '\t') {
			continue
		}
		rest = strings.TrimLeft(rest, " \t")
		if !strings.HasPrefix(rest, "Path:") {
			continue
		}
		rest = rest[len("Path:"):]
		if len(rest) == 0 || (rest[0] != ' ' && rest[0] != '\t') {
			continue
		}
		rest = strings.TrimSpace(rest)
		if c.close != "" {
			if !strings.HasSuffix(rest, c.close) {
				continue
			}
			rest = strings.TrimSpace(strings.TrimSuffix(rest, c.close))
		}
		rawPath, leader, found = rest, c, true
		break
	}
	if !found {
		return File{}, errors.New("missing Path: metadata line; use Path: src/App.tsx or a supported comment such as // Path: src/App.tsx, or send SOURCE_DIR + FILE frames")
	}
	if len(rawPath) == 0 || len(rawPath) > 2048 || strings.ContainsAny(rawPath, "\\\r\n\x00") ||
		strings.Contains(rawPath, "*/") || strings.Contains(rawPath, "-->") {
		return File{}, errors.New("invalid Path: header value")
	}
	if !strings.Contains(rawPath, "/") || strings.HasSuffix(rawPath, "/") ||
		path.Clean(rawPath) != rawPath || rawPath == "." || rawPath == ".." ||
		strings.HasPrefix(rawPath, "../") || strings.Contains(rawPath, "/../") ||
		strings.Contains(rawPath, "/./") || strings.Contains(rawPath, "://") {
		return File{}, errors.New("Path must be a full, clean slash-separated relative or absolute filepath, without traversal")
	}
	ext := extension(rawPath)
	expected, ok := comments[ext]
	if ext == ".env" || ext == ".gitignore" {
		expected, ok = comment{"#", ""}, true
	}
	if !ok {
		return File{}, fmt.Errorf("unsupported extension %q (strict JSON has no comment syntax; use .jsonc)", ext)
	}
	if !plain && leader != expected {
		return File{}, fmt.Errorf("%s requires header syntax: %s Path: %s%s", ext, expected.open, rawPath, ternary(expected.close != "", " "+expected.close, ""))
	}
	return File{Path: rawPath, Extension: ext}, nil
}

func ternary(cond bool, yes, no string) string {
	if cond {
		return yes
	}
	return no
}

// ParseForPath validates a framed source using its authoritative SOURCE_DIR +
// FILE identity. A Path: comment inside the source is optional and is not used
// to choose or override the stored path. Unframed files still use Parse.
// The supplied path is metadata: this function never opens it on disk.
func ParseForPath(content, fullPath string) (File, error) {
	if !utf8.ValidString(content) || strings.ContainsRune(content, '\x00') {
		return File{}, errors.New("file must be UTF-8 text without NUL bytes")
	}
	if len(fullPath) == 0 || len(fullPath) > 8192 || !path.IsAbs(fullPath) ||
		path.Clean(fullPath) != fullPath || strings.ContainsAny(fullPath, "\\\x00\r\n") ||
		strings.Contains(fullPath, "//") || strings.Contains(fullPath, "://") ||
		strings.HasSuffix(fullPath, "/") {
		return File{}, errors.New("SOURCE_DIR + FILE must form a clean absolute file path")
	}
	ext := extension(fullPath)
	// Framed JSON is safe: the SOURCE_DIR / FILE identity needs no comment.
	if _, ok := comments[ext]; !ok && ext != ".env" && ext != ".gitignore" && ext != ".json" {
		return File{}, fmt.Errorf("unsupported extension %q (strict JSON has no comment syntax; use .jsonc)", ext)
	}
	return File{Path: fullPath, Extension: ext}, nil
}
