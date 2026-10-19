// Package header checks the required extension-specific Path comment.
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
	lines := strings.SplitN(normalized, "\n", 3)
	first := strings.TrimSuffix(lines[0], "\r")
	// A shebang must stay first for executable scripts.
	if strings.HasPrefix(first, "#!") && len(lines) >= 2 {
		first = strings.TrimSuffix(lines[1], "\r")
	}
	// Use the longest matching comment leader. Handle JS/CSS/HTML safely.
	candidates := []comment{
		{"<!--", "-->"}, {"/*", "*/"}, {"//", ""}, {"--", ""}, {"#", ""},
	}
	var rawPath string
	var leader comment
	found := false
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
		return File{}, errors.New("first line must be a supported comment header such as '// Path: src/App.tsx'; shell shebang may precede it")
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
	if leader != expected {
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
