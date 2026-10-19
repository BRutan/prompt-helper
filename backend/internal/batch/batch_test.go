package batch

import (
	"fmt"
	"strings"
	"testing"
)

const sample = `################################################################################
SOURCE DIRECTORY: /Users/automigrate/Desktop/repos/scro.digital/scro-frontend/scro-mobile/scro-ios/scro-ios
################################################################################

================================================================================
SOURCE_DIR: /Users/automigrate/Desktop/repos/scro.digital/scro-frontend/scro-mobile/scro-ios/scro-ios
FILE: App/ContentView.swift
================================================================================

// Path: scro-frontend/scro-mobile/scro-ios/scro-ios/App/ContentView.swift
struct App { let text = "FILE: not a header" }

================================================================================
SOURCE_DIR: /Users/automigrate/Desktop/repos/scro.digital/scro-frontend/scro-mobile/scro-ios/scro-ios
FILE: Components/View/Another.swift
================================================================================

// Path: scro-frontend/scro-mobile/scro-ios/scro-ios/Components/View/Another.swift
struct Another {}
`

func TestParseSample(t *testing.T) {
	// Whitespace before a separator is not in real source dumps.
	input := strings.ReplaceAll(sample, "\n ================================================================================", "\n================================================================================")
	if !IsBatch(input) {
		t.Fatal("batch not detected")
	}
	files, err := Parse(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("got %d", len(files))
	}
	want := "/Users/automigrate/Desktop/repos/scro.digital/scro-frontend/scro-mobile/scro-ios/scro-ios/App/ContentView.swift"
	if files[0].Path != want {
		t.Fatalf("path=%q", files[0].Path)
	}
	if !strings.Contains(files[0].Content, "struct App") {
		t.Fatal("lost file body")
	}
	if !strings.HasPrefix(files[1].Content, "// Path:") {
		t.Fatal("invalid second source")
	}
}

func TestSafety(t *testing.T) {
	valid := strings.ReplaceAll(sample, "\n ================================================================================", "\n================================================================================")
	for _, input := range []string{
		strings.Replace(valid, "FILE: App/ContentView.swift", "FILE: ../secrets.swift", 1),
		strings.Replace(valid, "FILE: App/ContentView.swift", "FILE: /tmp/secrets.swift", 1),
		strings.Replace(valid, "FILE: App/ContentView.swift", "FILE: Components/View/Another.swift", 1),
	} {
		if _, err := Parse(input); err == nil {
			t.Fatal("accepted unsafe input")
		}
	}

}

// Test that no file-size or file-count caps prevent a valid batch.
func TestLargeFilesAndManySections(t *testing.T) {
	large := strings.Replace(sample, `struct App { let text = "FILE: not a header" }`, strings.Repeat("let value = 1\n", 160000), 1)
	files, err := Parse(large)
	if err != nil || len(files) != 2 || len(files[0].Content) <= 2*1024*1024 {
		t.Fatalf("large file not parsed: files=%d err=%v", len(files), err)
	}
	var many strings.Builder
	for i := 0; i < 501; i++ {
		fmt.Fprintf(&many, "================================================================================\nSOURCE_DIR: /src\nFILE: file%d.swift\n================================================================================\n\n// Path: src/file%d.swift\nlet x = %d\n\n", i, i, i)
	}
	files, err = Parse(many.String())
	if err != nil || len(files) != 501 {
		t.Fatalf("multiple files: got %d err=%v", len(files), err)
	}
}

func TestFrameOverridesPathHeader(t *testing.T) {
	input := "================================================================================\nSOURCE_DIR: /src\nFILE: app/admin/credit-risk/page.tsx\n================================================================================\n\n\"use client\";\nexport default function Page() { return null; }\n"
	sections, err := Parse(input)
	if err != nil || len(sections) != 1 || sections[0].Path != "/src/app/admin/credit-risk/page.tsx" || sections[0].Extension != ".tsx" {
		t.Fatalf("sections=%+v err=%v", sections, err)
	}
	conflicting := strings.Replace(input, "\"use client\";", "// Path: unrelated/page.tsx", 1)
	sections, err = Parse(conflicting)
	if err != nil || len(sections) != 1 || sections[0].Path != "/src/app/admin/credit-risk/page.tsx" {
		t.Fatalf("frame should override Path: sections=%+v err=%v", sections, err)
	}
}
