//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsExplicitRootResolvesJunctionAncestorFromPinnedHome(t *testing.T) {
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(parent, "home")
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "linked-parent")
	makeReparsePoint(t, "junction", link, parent)
	requested := filepath.Join(link, "home")
	pinned, err := os.OpenRoot(requested)
	if err != nil {
		t.Fatal(err)
	}
	defer pinned.Close()
	chain, err := selectedHomeChain(requested, parent, pinned)
	if err != nil {
		t.Fatalf("native handle opens the junction ancestor but chain resolution failed: %v", err)
	}
	if len(chain) != 2 {
		t.Fatalf("chain=%v, want only home and explicit parent", chain)
	}
	for index, path := range []string{home, parent} {
		actual, err := os.Stat(chain[index])
		if err != nil {
			t.Fatal(err)
		}
		want, err := os.Stat(path)
		if err != nil || !os.SameFile(actual, want) {
			t.Fatalf("chain entry %d is another object: %v", index, err)
		}
	}
	if err := syncHomeChainFrom(requested, parent, pinned); err != nil {
		t.Fatalf("resolved chain barrier: %v", err)
	}
}

func TestWindowsFinalDirectoryNameNormalization(t *testing.T) {
	for _, fixture := range []struct{ input, want string }{
		{`\\?\C:\Root\Home`, `C:\Root\Home`},
		{`\\?\C:\`, `C:\`},
		{`\\?\UNC\Server\Share\Root`, `\\Server\Share\Root`},
	} {
		t.Run(fixture.input, func(t *testing.T) {
			actual, err := normalizeFinalDirectoryName(fixture.input)
			if err != nil || actual != fixture.want {
				t.Fatalf("normalized=%q want=%q error=%v", actual, fixture.want, err)
			}
		})
	}
	for _, name := range []string{`C:\Root`, `\\?\C:relative`, `\\?\Volume{unknown}\Root`} {
		_, err := normalizeFinalDirectoryName(name)
		var failure *protocolError
		if !errors.As(err, &failure) || failure.code != "root_resolution_failed" {
			t.Fatalf("unexpected API name %q did not fail closed: %v", name, err)
		}
	}
}

func TestWindowsFinalDirectoryNameFailureIsSpecific(t *testing.T) {
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_ = root.Close()
	_, err = pinnedFinalDirectoryName(root)
	var failure *protocolError
	if !errors.As(err, &failure) || failure.code != "root_resolution_failed" {
		t.Fatalf("closed name handle did not fail specifically: %v", err)
	}
}
