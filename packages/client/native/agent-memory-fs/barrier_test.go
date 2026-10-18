//go:build !windows

package main

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func openedSession(t *testing.T, home string) *session {
	t.Helper()
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	info, err := root.Stat(".")
	if err != nil {
		t.Fatal(err)
	}
	identity, err := identityForRoot(root, info)
	_ = root.Close()
	if err != nil {
		t.Fatal(err)
	}
	active, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identity})
	if failure != nil {
		t.Fatalf("open: %#v", failure)
	}
	t.Cleanup(func() { _ = active.root.Close() })
	return active
}

func replaceRequestFor(name, before, after string) replaceRequest {
	return replaceRequest{ID: "replace", Protocol: protocolVersion, Op: "replace", Path: name,
		ExpectedRevision: stateForBytes([]byte(before)).Revision,
		ContentBase64:    base64.RawStdEncoding.EncodeToString([]byte(after)), MaxBytes: maxLocalLogBytes}
}

func TestStrictBarrierFailuresNeverBecomeConflict(t *testing.T) {
	for _, errno := range []error{syscall.ENOTSUP, syscall.EINVAL, syscall.EPERM, syscall.EIO} {
		for _, window := range []string{"temp", "parent"} {
			t.Run(errno.Error()+"/"+window, func(t *testing.T) {
				home := newMemoryHome(t)
				target := filepath.Join(home, "MEMORY.md")
				_ = os.WriteFile(target, []byte("old"), 0600)
				active := openedSession(t, home)
				original := strictSync
				t.Cleanup(func() { strictSync = original })
				calls := 0
				strictSync = func(file *os.File) error {
					info, err := file.Stat()
					if err != nil {
						return err
					}
					if (window == "parent") == info.IsDir() {
						calls++
						return errno
					}
					return original(file)
				}
				_, failure := active.replace(replaceRequestFor("MEMORY.md", "old", "new"))
				if failure == nil || failure.code != "io_failure" || calls != 1 {
					t.Fatalf("failure=%#v calls=%d", failure, calls)
				}
				data, _ := os.ReadFile(target)
				expected := "old"
				if window == "parent" {
					expected = "new"
				}
				if string(data) != expected {
					t.Fatalf("content=%q", data)
				}
				names, _ := os.ReadDir(home)
				for _, name := range names {
					if strings.HasPrefix(name.Name(), ".byok-replace") {
						t.Fatal("temp left after failed barrier")
					}
				}
			})
		}
	}
}

func TestFinalCASConflictsDoNotRename(t *testing.T) {
	for _, operation := range []string{"replace", "delete"} {
		for _, window := range []string{"initial", "final"} {
			t.Run(operation+"/"+window, func(t *testing.T) {
				home := newMemoryHome(t)
				target := filepath.Join(home, "MEMORY.md")
				_ = os.WriteFile(target, []byte("old"), 0600)
				active := openedSession(t, home)
				original := beforeFinalCAS
				t.Cleanup(func() { beforeFinalCAS = original })
				change := func() {
					if err := os.WriteFile(target, []byte("rival"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				if window == "initial" {
					change()
				} else {
					beforeFinalCAS = change
				}
				before, _ := os.Stat(target)
				var failure *protocolError
				if operation == "replace" {
					_, failure = active.replace(replaceRequestFor("MEMORY.md", "old", "new"))
				} else {
					_, failure = active.delete(deleteRequest{ID: "delete", Protocol: protocolVersion, Op: "delete", Path: "MEMORY.md", ExpectedRevision: stateForBytes([]byte("old")).Revision})
				}
				after, _ := os.Stat(target)
				data, _ := os.ReadFile(target)
				if failure == nil || failure.code != "revision_conflict" || string(data) != "rival" || !os.SameFile(before, after) {
					t.Fatalf("failure=%#v content=%q", failure, data)
				}
				names, _ := os.ReadDir(home)
				for _, name := range names {
					if strings.HasPrefix(name.Name(), ".byok-") {
						t.Fatalf("unexpected entry %q", name.Name())
					}
				}
			})
		}
	}
}

func TestHomeChainBarrierIsStrictBeforeOpen(t *testing.T) {
	home := newMemoryHome(t)
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	info, err := root.Stat(".")
	if err != nil {
		t.Fatal(err)
	}
	identity, err := identityForRoot(root, info)
	t.Cleanup(func() { _ = root.Close() })
	if err != nil {
		t.Fatal(err)
	}
	original := strictSync
	originalCAS := beforeFinalCAS
	t.Cleanup(func() { strictSync = original; beforeFinalCAS = originalCAS })
	calls, casCalls := 0, 0
	beforeFinalCAS = func() { casCalls++ }
	strictSync = func(file *os.File) error { calls++; return syscall.EIO }
	if err := syncHomeChain(home, root); !errors.Is(err, syscall.EIO) || calls != 1 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	calls = 0
	active, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identity})
	if active != nil || failure == nil || failure.code != "io_failure" || calls != 1 || casCalls != 0 {
		t.Fatalf("session=%v failure=%#v calls=%d CAS=%d", active, failure, calls, casCalls)
	}
	strictSync = original
	_ = openedSession(t, home) // A failed preflight must not leave authority held.
}

func TestDeleteAndAppendBarrierFailuresAreIO(t *testing.T) {
	for _, operation := range []string{"delete-first", "delete-second", "append-file", "append-parent"} {
		t.Run(operation, func(t *testing.T) {
			home := newMemoryHome(t)
			active := openedSession(t, home)
			original := strictSync
			t.Cleanup(func() { strictSync = original })
			target := filepath.Join(home, "MEMORY.md")
			_ = os.WriteFile(target, []byte("old"), 0600)
			calls := 0
			failAt := 1
			if operation == "delete-second" || operation == "append-parent" {
				failAt = 2
			}
			strictSync = func(file *os.File) error {
				calls++
				if calls == failAt {
					return syscall.EIO
				}
				return original(file)
			}
			var failure *protocolError
			if strings.HasPrefix(operation, "delete") {
				_, failure = active.delete(deleteRequest{ID: "delete", Protocol: protocolVersion, Op: "delete", Path: "MEMORY.md", ExpectedRevision: stateForBytes([]byte("old")).Revision})
			} else {
				_, failure = active.append(appendRequest{ID: "append", Protocol: protocolVersion, Op: "append", Path: "notes/new.md", Content: "new", MaxBytes: 1024})
			}
			if failure == nil || failure.code != "io_failure" || calls != failAt {
				t.Fatalf("failure=%#v calls=%d", failure, calls)
			}
		})
	}
}

func TestHomeChainRejectsSwapAndRestore(t *testing.T) {
	home, err := filepath.EvalSymlinks(newMemoryHome(t))
	if err != nil {
		t.Fatal(err)
	}
	parentInfo, _ := os.Stat(filepath.Dir(home))
	homeInfo, _ := os.Stat(home)
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	identity, err := identityForRoot(root, homeInfo)
	if err != nil {
		t.Fatal(err)
	}
	original := strictSync
	held := home + ".held"
	swapped, restored, syncedReplacement := false, false, false
	t.Cleanup(func() {
		strictSync = original
		if swapped && !restored {
			_ = os.Remove(home)
			_ = os.Rename(held, home)
		}
	})
	strictSync = func(file *os.File) error {
		info, err := file.Stat()
		if err != nil {
			return err
		}
		if err := original(file); err != nil {
			return err
		}
		if os.SameFile(info, parentInfo) && !swapped {
			if err := os.Rename(home, held); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(home, 0700); err != nil {
				t.Fatal(err)
			}
			swapped = true
		} else if swapped && !restored && !os.SameFile(info, homeInfo) {
			replacement, _ := os.Stat(home)
			if os.SameFile(info, replacement) {
				syncedReplacement = true
				_ = os.Remove(home)
				_ = os.Rename(held, home)
				restored = true
			}
		}
		return nil
	}
	active, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identity})
	if active != nil {
		_ = active.root.Close()
	}
	if !swapped || active != nil || failure == nil || failure.code != "io_failure" || syncedReplacement {
		t.Fatalf("accepted=%v swapped=%v syncedReplacement=%v failure=%#v", active != nil, swapped, syncedReplacement, failure)
	}
}

func TestLedgerReplaceStrictOrderAndFailureWindows(t *testing.T) {
	for _, window := range []string{"success", "temp", "parent"} {
		t.Run(window, func(t *testing.T) {
			home := newMemoryHome(t)
			if err := os.Mkdir(filepath.Join(home, ".byok"), 0700); err != nil {
				t.Fatal(err)
			}
			active := openedSession(t, home)
			original := strictSync
			t.Cleanup(func() { strictSync = original })
			var order []string
			strictSync = func(file *os.File) error {
				info, err := file.Stat()
				if err != nil {
					return err
				}
				step := "temp"
				if info.IsDir() {
					step = "parent"
				}
				order = append(order, step)
				if window == step {
					return syscall.EIO
				}
				return original(file)
			}
			_, failure := active.replace(replaceRequestFor(".byok/agent-memory-intents-v1.json", "", "applying"))
			target := filepath.Join(home, ".byok", "agent-memory-intents-v1.json")
			content, readErr := os.ReadFile(target)
			if window == "success" {
				if failure != nil || string(content) != "applying" || strings.Join(order, ",") != "temp,parent" {
					t.Fatalf("failure=%#v order=%v content=%q", failure, order, content)
				}
			} else {
				if failure == nil || failure.code != "io_failure" {
					t.Fatalf("failure=%#v", failure)
				}
				if window == "temp" && (!os.IsNotExist(readErr) || strings.Join(order, ",") != "temp") {
					t.Fatal("temp failure published ledger or fell back")
				}
				if window == "parent" && (string(content) != "applying" || strings.Join(order, ",") != "temp,parent") {
					t.Fatal("parent failure lost the visible uncertain boundary")
				}
			}
		})
	}
}
