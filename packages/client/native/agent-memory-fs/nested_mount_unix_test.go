//go:build !windows

package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"syscall"
	"testing"
)

// requireMountedChild opens base and fails unless child is on another device.
// A mount on another device is the only way a runner gets such a child
// without privileges, so a failed precondition fails the test, not skips it.
func requireMountedChild(t *testing.T, base, child string) *session {
	t.Helper()
	root, err := os.OpenRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	parent, err := root.Stat(".")
	if err != nil {
		t.Fatal(err)
	}
	entry, err := root.Lstat(child)
	if err != nil {
		t.Fatal(err)
	}
	if !entry.IsDir() || parent.Sys().(*syscall.Stat_t).Dev == entry.Sys().(*syscall.Stat_t).Dev {
		t.Fatalf("%s/%s is not a directory on another device", base, child)
	}
	// Not openSession: the volume rule and the chain barrier are for a home,
	// not a system root. Only the operations below the root are under test.
	return &session{root: root}
}

// The real kernel: /dev is devfs on macOS and devtmpfs on Linux, mounted below
// /. Before the device rule, read returned an empty file state and delete a
// revision conflict. Neither operation writes, so a regression writes nothing.
func TestRealNestedMountIsRefused(t *testing.T) {
	active := requireMountedChild(t, "/", "dev")
	path := "dev/" + temporaryName("absent")
	for _, operation := range []string{"read", "delete"} {
		if failure := pinnedOperation(active, operation, path, stateForBytes(nil).Revision); failure == nil || failure.code != "unsafe_path" {
			t.Fatalf("%s below a nested mount: %#v", operation, failure)
		}
	}
}

func TestReleaseEntryVolumeBindsSameVolume(t *testing.T) {
	if reflect.ValueOf(sameEntryVolume).Pointer() != reflect.ValueOf(sameVolume).Pointer() {
		t.Fatal("release entry volume check does not bind sameVolume")
	}
}

// The seam reports one entry on another device, or a failed comparison. A
// runner cannot mount without privileges below a temp home, and Linux can
// also mount a single file. These cases run serially: they replace a global.
func TestNestedMountSeamRefusesEveryOperation(t *testing.T) {
	for _, mounted := range []struct {
		name  string
		entry string
		err   error
	}{
		{"parent-directory", "notes", nil},
		{"walked-subdirectory", "sub", nil},
		{"leaf-file", "entry.md", nil},
		{"comparison-failed", "notes", errors.New("comparison failed")},
	} {
		// Without the device rule each operation succeeds on a fresh home.
		for _, operation := range []string{"read", "replace", "delete", "append", "walk"} {
			t.Run(mounted.name+"/"+operation, func(t *testing.T) {
				home := newMemoryHome(t)
				if err := os.MkdirAll(filepath.Join(home, "notes", "sub"), 0o700); err != nil {
					t.Fatal(err)
				}
				writeHomeFile(t, filepath.Join(home, "notes", "entry.md"), "inside")
				writeHomeFile(t, filepath.Join(home, "notes", "sub", "deep.md"), "deep")
				active := openNamesSession(t, home)
				original := sameEntryVolume
				t.Cleanup(func() { sameEntryVolume = original })
				sameEntryVolume = func(parent, entry fs.FileInfo) (bool, error) {
					if entry.Name() == mounted.entry {
						return false, mounted.err
					}
					return sameVolume(parent, entry)
				}
				path, revision := "notes/entry.md", stateForBytes([]byte("inside")).Revision
				if mounted.entry == "sub" {
					path, revision = "notes/sub/deep.md", stateForBytes([]byte("deep")).Revision
				}
				if operation == "walk" {
					path = "notes"
				}
				if failure := pinnedOperation(active, operation, path, revision); failure == nil || failure.code != "unsafe_path" {
					t.Fatalf("%s with %s on another device: %#v", operation, mounted.entry, failure)
				}
				assertSentinel(t, filepath.Join(home, "notes", "entry.md"), "inside")
				assertSentinel(t, filepath.Join(home, "notes", "sub", "deep.md"), "deep")
				requireEntries(t, filepath.Join(home, "notes"), "entry.md", "sub")
				requireEntries(t, filepath.Join(home, "notes", "sub"), "deep.md")
			})
		}
	}
}

func writeHomeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// requireEntries fails when a write, a temp or a tombstone is left in dir.
func requireEntries(t *testing.T, dir string, want ...string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !slices.Equal(names, want) {
		t.Fatalf("%s entries = %v, want %v", dir, names, want)
	}
}
