//go:build windows

package main

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"syscall"
	"testing"
)

// Windows reparse points replace a name after the session pinned the home:
// the parent and leaf cases of TestRootParentAndLeafSymlinkSwapsCannotTouchOutsideSentinel
// in main_test.go, which is !windows. Go 1.23 and later report a junction as
// ModeIrregular and a symlink as ModeSymlink. openSession stays closed on
// Windows, so these tests build the session themselves and cannot check a home
// swap before open. A pass is not admission, a full reparse matrix or model S
// proof, and it does not grant B.

// errorSharingViolation is ERROR_SHARING_VIOLATION, which package syscall does
// not name.
const errorSharingViolation = syscall.Errno(32)

// makeReparsePoint creates link to target. A failed fixture fails the test:
// go test exits 0 for a skip, and a skip is no evidence.
func makeReparsePoint(t *testing.T, kind, link, target string) {
	t.Helper()
	want := os.ModeSymlink
	if kind == "junction" {
		want = os.ModeIrregular
		if output, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
			t.Fatalf("junction setup failed: %v (%s)", err, output)
		}
	} else if err := os.Symlink(target, link); err != nil {
		t.Fatalf("%s setup failed: %v", kind, err)
	}
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&want == 0 {
		t.Fatalf("%s fixture has mode %v", kind, info.Mode())
	}
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// requireOutsideUnchanged checks that dir holds only the sentinel, unchanged.
// A followed link would leave a write, a temp or a tombstone there.
func requireOutsideUnchanged(t *testing.T, dir, sentinel, content string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, sentinel))
	if err != nil || string(data) != content {
		t.Fatalf("outside sentinel changed: %q, %v", data, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !slices.Equal(names, []string{sentinel}) {
		t.Fatalf("outside directory entries = %v", names)
	}
}

// pinnedOperation runs one helper operation. Replace and delete carry the
// outside sentinel's revision, so a followed link would pass the CAS.
func pinnedOperation(active *session, operation, path, revision string) *protocolError {
	var failure *protocolError
	switch operation {
	case "read":
		_, failure = active.read(readRequest{ID: "read", Protocol: protocolVersion, Op: "read", Path: path, MaxBytes: maxFileBytes})
	case "replace":
		_, failure = active.replace(replaceRequest{ID: "replace", Protocol: protocolVersion, Op: "replace", Path: path, ExpectedRevision: revision,
			ContentBase64: base64.RawStdEncoding.EncodeToString([]byte("must-not-write-outside")), MaxBytes: maxFileBytes})
	case "delete":
		_, failure = active.delete(deleteRequest{ID: "delete", Protocol: protocolVersion, Op: "delete", Path: path, ExpectedRevision: revision})
	case "append":
		_, failure = active.append(appendRequest{ID: "append", Protocol: protocolVersion, Op: "append", Path: path, Content: "must-not-write-outside", MaxBytes: maxFileBytes})
	case "walk":
		_, failure = active.walk(walkRequest{ID: "walk", Protocol: protocolVersion, Op: "walk", Path: path, MaxEntries: 8})
	default:
		panic("unknown operation " + operation)
	}
	return failure
}

func TestWindowsReparseParentSwapCannotTouchOutsideSentinel(t *testing.T) {
	for _, kind := range []string{"junction", "directory-symlink"} {
		t.Run(kind, func(t *testing.T) {
			home, active := pinnedNTFSSession(t)
			outside := t.TempDir()
			writeFixture(t, filepath.Join(outside, "entry.md"), "outside")
			revision := stateForBytes([]byte("outside")).Revision
			if err := os.Rename(filepath.Join(home, "notes"), filepath.Join(home, "notes-real")); err != nil {
				t.Fatal(err)
			}
			makeReparsePoint(t, kind, filepath.Join(home, "notes"), outside)
			for _, operation := range []string{"read", "replace", "delete", "append", "walk"} {
				path := "notes/entry.md"
				if operation == "walk" {
					path = "notes"
				}
				if failure := pinnedOperation(active, operation, path, revision); failure == nil || failure.code != "unsafe_path" {
					t.Fatalf("%s through a %s parent: %#v", operation, kind, failure)
				}
			}
			requireOutsideUnchanged(t, outside, "entry.md", "outside")
		})
	}
}

func TestWindowsReparseLeafSwapCannotTouchOutsideSentinel(t *testing.T) {
	for _, kind := range []string{"file-symlink", "directory-symlink", "junction"} {
		t.Run(kind, func(t *testing.T) {
			home, active := pinnedNTFSSession(t)
			entry := filepath.Join(home, "notes", "entry.md")
			writeFixture(t, entry, "inside")
			if failure := pinnedOperation(active, "read", "notes/entry.md", ""); failure != nil {
				t.Fatalf("read before the swap: %#v", failure)
			}
			outside := t.TempDir()
			writeFixture(t, filepath.Join(outside, "sentinel.md"), "outside")
			revision := stateForBytes([]byte("outside")).Revision
			if err := os.Remove(entry); err != nil {
				t.Fatal(err)
			}
			target := outside
			if kind == "file-symlink" {
				target = filepath.Join(outside, "sentinel.md")
			}
			makeReparsePoint(t, kind, entry, target)
			for _, operation := range []string{"read", "replace", "delete", "append", "walk"} {
				path := "notes/entry.md"
				if operation == "walk" {
					path = "notes"
				}
				if failure := pinnedOperation(active, operation, path, revision); failure == nil || failure.code != "unsafe_path" {
					t.Fatalf("%s through a %s leaf: %#v", operation, kind, failure)
				}
			}
			requireOutsideUnchanged(t, outside, "sentinel.md", "outside")
		})
	}
}

// os.OpenRoot opens the home without FILE_SHARE_DELETE, so Windows can refuse
// to rename it while the session holds it. If the rename succeeds, a junction
// takes the old name, and the next write must still land in the pinned
// directory.
func TestWindowsPinnedHomeSwapCannotRedirectWrites(t *testing.T) {
	home, active := pinnedNTFSSession(t)
	outside := t.TempDir()
	writeFixture(t, filepath.Join(outside, "sentinel.md"), "outside")
	pinned := home
	renameErr := os.Rename(home, home+"-moved")
	t.Logf("OBSERVED rename of the pinned home: %v", renameErr)
	switch {
	case renameErr == nil:
		pinned = home + "-moved"
		makeReparsePoint(t, "junction", home, outside)
	case errors.Is(renameErr, errorSharingViolation), errors.Is(renameErr, syscall.ERROR_ACCESS_DENIED):
	default:
		t.Fatalf("unexpected rename error: %v", renameErr)
	}
	if _, failure := active.replace(replaceRequest{ID: "replace", Protocol: protocolVersion, Op: "replace", Path: "notes/entry.md",
		ExpectedRevision: emptyFileState().Revision, ContentBase64: base64.RawStdEncoding.EncodeToString([]byte("inside")), MaxBytes: maxFileBytes}); failure != nil {
		t.Fatalf("write after the home rename: %#v", failure)
	}
	data, err := os.ReadFile(filepath.Join(pinned, "notes", "entry.md"))
	if err != nil || string(data) != "inside" {
		t.Fatalf("write did not land in the pinned home: %q, %v", data, err)
	}
	requireOutsideUnchanged(t, outside, "sentinel.md", "outside")
}
