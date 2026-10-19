package header

import "testing"

func TestParse(t *testing.T) {
	cases := []struct {
		content, path, ext string
		ok                 bool
	}{
		{"// Path: scro-ios/App/ContentView.swift\nstruct Foo {}", "scro-ios/App/ContentView.swift", ".swift", true},
		{"# Path: jobs/random_transaction/ingest.py\nprint('hi')", "jobs/random_transaction/ingest.py", ".py", true},
		{"#!/usr/bin/env bash\n# Path: scripts/run.sh\necho hi", "scripts/run.sh", ".sh", true},
		{"<!-- Path: web/index.html -->\n<html/>", "web/index.html", ".html", true},
		{"/* Path: web/main.css */\nbody{}", "web/main.css", ".css", true},
		{"-- Path: db/schema.sql\nSELECT 1", "db/schema.sql", ".sql", true},
		{"# Path: /repo/Makefile\nall:", "/repo/Makefile", ".mk", true},
		{"# Path: ops/Dockerfile.backend\nFROM alpine", "ops/Dockerfile.backend", ".mk", true},
		{"# Path: ops/.env\nX=1", "ops/.env", ".env", true},
		{"// Path: web/main.css\nbody{}", "", "", false},
		{"// Path: src/main.json\n{}", "", "", false},
		{"// Path: src/../main.ts\nx", "", "", false},
		{"// Path: App.tsx\nx", "", "", false},
		{"//Path: src/App.tsx\nx", "", "", false},
		{"// Path: src/a.ts\n\x00", "", "", false},
		{"hello", "", "", false},
	}
	for _, tc := range cases {
		got, err := Parse(tc.content)
		if (err == nil) != tc.ok {
			t.Errorf("Parse(%q): err=%v", tc.content, err)
			continue
		}
		if tc.ok && (got.Path != tc.path || got.Extension != tc.ext) {
			t.Errorf("Parse(%q) = %#v; want (%q,%q)", tc.content, got, tc.path, tc.ext)
		}
	}
}
