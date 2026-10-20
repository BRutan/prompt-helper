// Path: backend/cmd/server/chat_sessions_test.go
package main

import (
	"strings"
	"testing"
)

func TestValidChatIdentity(t *testing.T) {
	for _, tc := range []struct {
		provider, id string
		valid        bool
	}{
		{"chatgpt", "abc-123", true},
		{"claude", "aa_bB22", true},
		{"other", "abc", false},
		{"chatgpt", "../secrets", false},
		{"claude", "", false},
	} {
		if got := validChatIdentity(tc.provider, tc.id); got != tc.valid {
			t.Errorf("validChatIdentity(%q,%q)=%v want %v", tc.provider, tc.id, got, tc.valid)
		}
	}
}

func TestParseChatSource(t *testing.T) {
	single := "// Path: src/demo.go\npackage main\n"
	got, err := parseChatSource(single)
	if err != nil || len(got) != 1 || got[0].Path != "src/demo.go" {
		t.Fatalf("single=%+v err=%v", got, err)
	}
	frame := strings.Repeat("=", 80) + "\nSOURCE_DIR: /Users/test/repo\nFILE: src/demo.go\n" + strings.Repeat("=", 80) + "\n\npackage main\n"
	got, err = parseChatSource(frame)
	if err != nil || len(got) != 1 || got[0].Path != "/Users/test/repo/src/demo.go" {
		t.Fatalf("batch=%+v err=%v", got, err)
	}
	jsonFrame := strings.Repeat("=", 80) + "\nSOURCE_DIR: /Users/test/repo\nFILE: config/options.json\n" + strings.Repeat("=", 80) + "\n\n{\"enabled\":true}\n"
	got, err = parseChatSource(jsonFrame)
	if err != nil || len(got) != 1 || got[0].Extension != ".json" {
		t.Fatalf("framed JSON=%+v err=%v", got, err)
	}
	if _, err := parseChatSource("random prose with no path"); err == nil {
		t.Fatal("accepted arbitrary prose")
	}
}
