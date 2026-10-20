package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsFileIdentityIsStableDistinctAndDoesNotLockOriginal(t *testing.T) {
	root := t.TempDir()
	a, b := filepath.Join(root, "a.txt"), filepath.Join(root, "b.txt")
	if e := os.WriteFile(a, []byte("same text"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(b, []byte("same text"), 0600); e != nil {
		t.Fatal(e)
	}
	info, e := os.Stat(a)
	if e != nil {
		t.Fatal(e)
	}
	first := fileIdentity(a, info)
	if first == "" || first != fileIdentity(a, info) {
		t.Fatal("missing or unstable Windows file identity")
	}
	other, e := os.Stat(b)
	if e != nil {
		t.Fatal(e)
	}
	if first == fileIdentity(b, other) {
		t.Fatal("distinct files share identity")
	}
	renamed := filepath.Join(root, "renamed.txt")
	if e = os.Rename(a, renamed); e != nil {
		t.Fatal("metadata lookup locked the original", e)
	}
	after, e := os.Stat(renamed)
	if e != nil {
		t.Fatal(e)
	}
	if first != fileIdentity(renamed, after) {
		t.Fatal("rename changed file identity")
	}
	linked := filepath.Join(root, "hardlink.txt")
	if e = os.Link(renamed, linked); e != nil {
		t.Fatal(e)
	}
	link, e := os.Stat(linked)
	if e != nil {
		t.Fatal(e)
	}
	if first != fileIdentity(linked, link) {
		t.Fatal("same physical file through a hard link has a different identity")
	}
}
