//go:build windows

package main

import (
	"encoding/base64"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// #522 window on real NTFS: the memory rename is visible, then the parent
// directory barrier runs. The spy only records each real platformStrictSync
// result on a directory handle. If any such barrier fails, the operation must
// be io_failure, never success or revision_conflict. If all succeed, it must
// succeed. openSession stays closed on Windows, so the test builds the session
// itself. It exercises this window only. It is not containment, admission or
// model S proof, and a pass does not grant B.
func TestWindowsMemoryResultBarrierFailsClosedOnNTFS(t *testing.T) {
	for _, operation := range []string{"replace-existing", "replace-new", "delete"} {
		t.Run(operation, func(t *testing.T) {
			home := t.TempDir()
			target := filepath.Join(home, "notes", "a.md")
			if err := os.Mkdir(filepath.Dir(target), 0o700); err != nil {
				t.Fatal(err)
			}
			base := emptyFileState().Revision
			if operation != "replace-new" {
				if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
					t.Fatal(err)
				}
				base = stateForBytes([]byte("old")).Revision
			}
			root, err := os.OpenRoot(home)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			active := &session{root: root}

			original := strictSync
			t.Cleanup(func() { strictSync = original })
			var directoryBarriers []error
			strictSync = func(file *os.File) error {
				syncErr := original(file)
				info, statErr := file.Stat()
				if statErr != nil {
					t.Errorf("barrier handle stat failed: %v", statErr)
				} else if info.IsDir() {
					directoryBarriers = append(directoryBarriers, syncErr)
				}
				return syncErr
			}

			var failure *protocolError
			if operation == "delete" {
				_, failure = active.delete(deleteRequest{ID: "delete", Protocol: protocolVersion, Op: "delete", Path: "notes/a.md", ExpectedRevision: base})
			} else {
				_, failure = active.replace(replaceRequest{ID: "replace", Protocol: protocolVersion, Op: "replace", Path: "notes/a.md",
					ExpectedRevision: base, ContentBase64: base64.RawStdEncoding.EncodeToString([]byte("new")), MaxBytes: 1024})
			}

			// The barrier ran after the rename: a delete removed the name, a
			// replace installed the new bytes.
			content, readErr := os.ReadFile(target)
			if operation == "delete" {
				if !errors.Is(readErr, fs.ErrNotExist) {
					t.Fatalf("delete rename did not happen: content=%q err=%v", content, readErr)
				}
			} else if readErr != nil || string(content) != "new" {
				t.Fatalf("replace rename did not happen: content=%q err=%v", content, readErr)
			}
			if len(directoryBarriers) == 0 {
				t.Fatal("no directory barrier ran after the rename")
			}
			barrierErr := errors.Join(directoryBarriers...)
			t.Logf("OBSERVED NTFS directory barriers=%d error=%v result=%v", len(directoryBarriers), barrierErr, failure)
			if barrierErr != nil {
				if failure == nil || failure.code != "io_failure" {
					t.Fatalf("a failed directory barrier must be io_failure, got %#v", failure)
				}
			} else if failure != nil {
				t.Fatalf("every directory barrier succeeded, got %#v", failure)
			}
		})
	}
}
