package patch

import (
	"context"
	"strings"
	"testing"
)

func TestInitial(t *testing.T) {
	r := Initial("src/a.py", "# Path: src/a.py\nprint('ok')\n")
	if r.Additions != 2 || len(r.Lines) != 2 || !strings.Contains(r.LLM, "BASELINE v1") {
		t.Fatalf("unexpected baseline: %#v", r)
	}
}

func TestDiff(t *testing.T) {
	r, err := Diff(context.Background(), "src/a.py", "one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n")
	if err != nil {
		t.Fatal(err)
	}
	if r.Additions != 2 || r.Deletions != 1 {
		t.Fatalf("counts: %#v", r)
	}
	if !strings.Contains(r.Unified, "--- a/src/a.py") || !strings.Contains(r.LLM, "- two") {
		t.Fatal(r.LLM)
	}
	for _, line := range r.Lines {
		if line.Kind == "added" && line.NewLine == nil {
			t.Fatal("added line missing destination number")
		}
		if line.Kind == "removed" && line.OldLine == nil {
			t.Fatal("removed line missing source number")
		}
	}
}

func TestNoNewline(t *testing.T) {
	r, err := Diff(context.Background(), "src/a.txt", "old", "new")
	if err != nil {
		t.Fatal(err)
	}
	if r.Additions != 1 || r.Deletions != 1 {
		t.Fatalf("unexpected diff: %#v", r)
	}
}
