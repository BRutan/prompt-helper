// Path: backend/cmd/server/upload_test.go
package main

import (
	"testing"
)

func TestUploadFilename(t *testing.T) {
	for _, name := range []string{"../secrets", "/etc/passwd", "a.txt", "20261019T155125123Z-12345.txt", "20261019T155125123Z-1234567890abcdef1234567890abcdef.txt/../x"} {
		if _, err := uploadPath("/data/uploads", name); err == nil {
			t.Errorf("accepted unsafe filename %q", name)
		}
	}
	name := "20261019T155125123Z-1234567890abcdef1234567890abcdef.txt"
	got, err := uploadPath("/data/uploads", name)
	if err != nil || got != "/data/uploads/"+name {
		t.Fatalf("path=%q err=%v", got, err)
	}
}

func TestUploadedIdentity(t *testing.T) {
	content := "// Path: scro-frontend/scro-mobile/scro-ios/scro-ios/App/ContentView.swift\nstruct ContentView {}\n"
	resolved, err := parseUploadedSource(content, "/Users/example/scro.digital/scro-frontend/scro-mobile/scro-ios/scro-ios/App/ContentView.swift")
	if err != nil || resolved.Path != "/Users/example/scro.digital/scro-frontend/scro-mobile/scro-ios/scro-ios/App/ContentView.swift" {
		t.Fatalf("resolved=%v err=%v", resolved, err)
	}
	for _, name := range []string{"../../bad", "/Users/example/../../bad.swift", "/Users/example/other.swift"} {
		if _, err := parseUploadedSource(content, name); err == nil {
			t.Errorf("accepted invalid identity %q", name)
		}
	}
}

func TestUploadedPlainPath(t *testing.T) {
	content := "Path: scripts/simulator_appium_navigation.py\nprint('ok')\n"
	wanted := "/Users/example/repo/scripts/simulator_appium_navigation.py"
	file, err := parseUploadedSource(content, wanted)
	if err != nil || file.Path != wanted || file.Extension != ".py" {
		t.Fatalf("file=%+v err=%v", file, err)
	}
	other, err := parseUploadedSource(content, "/Users/example/repo/scripts/other.py")
	if err != nil || other.Path != "/Users/example/repo/scripts/other.py" {
		t.Fatalf("frame should override Path comment: file=%+v err=%v", other, err)
	}
}

func TestUploadedFrameWithoutPathComment(t *testing.T) {
	content := "\"use client\";\nexport default function Page() { return null; }\n"
	wanted := "/Users/example/repo/src/app/admin/credit-risk/page.tsx"
	file, err := parseUploadedSource(content, wanted)
	if err != nil || file.Path != wanted || file.Extension != ".tsx" {
		t.Fatalf("file=%+v err=%v", file, err)
	}
	if _, err := parseUploadedSource(content, ""); err == nil {
		t.Fatal("unframed source without Path header must still fail")
	}
}
