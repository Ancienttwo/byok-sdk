//go:build windows

package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// Windows ports of the four failure-injection tests in barrier_test.go, which
// is !windows. The spy fails the chosen barrier and passes every other call to
// the real platformStrictSync, which must succeed on NTFS. A pass covers the
// helper failure paths only. It is not model S proof, and it does not grant B.

// Errors that a Windows flush can return: no write access on the handle
// (#580), no flush support on the device or file system, a device I/O error.
var windowsBarrierErrors = []struct {
	name  string
	errno syscall.Errno
}{
	{"ERROR_ACCESS_DENIED", syscall.ERROR_ACCESS_DENIED},
	{"ERROR_INVALID_FUNCTION", syscall.Errno(1)},
	{"ERROR_NOT_SUPPORTED", syscall.Errno(50)},
	{"ERROR_IO_DEVICE", syscall.Errno(1117)},
}

// pinnedNTFSSession opens a session on an NTFS home that holds notes/ and
// MEMORY.md with "old", the layout of newMemoryHome in main_test.go.
func pinnedNTFSSession(t *testing.T) (string, *session) {
	t.Helper()
	home := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(filepath.Join(home, "notes"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "MEMORY.md"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	active, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identityForTest(t, home)})
	if failure != nil {
		t.Fatalf("open: %#v", failure)
	}
	t.Cleanup(func() { _ = active.root.Close() })
	requireNTFS(t, active.root)
	return home, active
}

type barrierSpy struct {
	order    []string
	injected int
}

// spyBarriers fails each barrier call for which fail returns true. Every
// other call runs the real platformStrictSync, and a real failure fails the
// test: an injected error must never hide one.
func spyBarriers(t *testing.T, errno syscall.Errno, fail func(call int, directory bool) bool) *barrierSpy {
	t.Helper()
	spy := &barrierSpy{}
	original := strictSync
	t.Cleanup(func() { strictSync = original })
	strictSync = func(file *os.File) error {
		info, err := file.Stat()
		if err != nil {
			t.Errorf("barrier handle stat failed: %v", err)
			return err
		}
		step := "temp"
		if info.IsDir() {
			step = "parent"
		}
		spy.order = append(spy.order, step)
		if fail(len(spy.order), info.IsDir()) {
			spy.injected++
			return errno
		}
		if err := original(file); err != nil {
			t.Errorf("real %s barrier %d failed on NTFS: %v", step, len(spy.order), err)
			return err
		}
		return nil
	}
	return spy
}

func injectedReplace(name, before, after string) replaceRequest {
	return replaceRequest{ID: "replace", Protocol: protocolVersion, Op: "replace", Path: name,
		ExpectedRevision: stateForBytes([]byte(before)).Revision,
		ContentBase64:    base64.RawStdEncoding.EncodeToString([]byte(after)), MaxBytes: maxLocalLogBytes}
}

// requireNoHelperEntries checks for a temp or tombstone left in dir. The
// helper names both with temporaryName.
func requireNoHelperEntries(t *testing.T, dir string) {
	t.Helper()
	names, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if strings.HasPrefix(name.Name(), ".byok-agent-memory-") {
			t.Fatalf("helper entry left after the operation: %q", name.Name())
		}
	}
}

// handleFileID reads the volume serial and file index through an open
// handle. os.Stat on Windows loads them later, from the path, when
// os.SameFile runs, so two path Stat results taken around a rename match.
func handleFileID(t *testing.T, path string) syscall.ByHandleFileInformation {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var information syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &information); err != nil {
		t.Fatal(err)
	}
	return information
}

func sameFileID(a, b syscall.ByHandleFileInformation) bool {
	return a.VolumeSerialNumber == b.VolumeSerialNumber && a.FileIndexHigh == b.FileIndexHigh && a.FileIndexLow == b.FileIndexLow
}

func TestWindowsStrictBarrierFailuresNeverBecomeConflict(t *testing.T) {
	for _, injected := range windowsBarrierErrors {
		for _, window := range []string{"temp", "parent"} {
			t.Run(injected.name+"/"+window, func(t *testing.T) {
				home, active := pinnedNTFSSession(t)
				target := filepath.Join(home, "MEMORY.md")
				spy := spyBarriers(t, injected.errno, func(_ int, directory bool) bool { return (window == "parent") == directory })
				_, failure := active.replace(injectedReplace("MEMORY.md", "old", "new"))
				if failure == nil || failure.code != "io_failure" || spy.injected != 1 {
					t.Fatalf("failure=%#v injected=%d order=%v", failure, spy.injected, spy.order)
				}
				data, _ := os.ReadFile(target)
				expected := "old"
				if window == "parent" {
					expected = "new"
				}
				if string(data) != expected {
					t.Fatalf("content=%q", data)
				}
				requireNoHelperEntries(t, home)
			})
		}
	}
}

func TestWindowsFinalCASConflictsDoNotRename(t *testing.T) {
	for _, operation := range []string{"replace", "delete"} {
		for _, window := range []string{"initial", "final"} {
			t.Run(operation+"/"+window, func(t *testing.T) {
				home, active := pinnedNTFSSession(t)
				target := filepath.Join(home, "MEMORY.md")
				original := beforeFinalCAS
				t.Cleanup(func() { beforeFinalCAS = original })
				change := func() {
					if err := os.WriteFile(target, []byte("rival"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				if window == "initial" {
					change()
				} else {
					beforeFinalCAS = change
				}
				before := handleFileID(t, target)
				var failure *protocolError
				if operation == "replace" {
					_, failure = active.replace(injectedReplace("MEMORY.md", "old", "new"))
				} else {
					_, failure = active.delete(deleteRequest{ID: "delete", Protocol: protocolVersion, Op: "delete", Path: "MEMORY.md", ExpectedRevision: stateForBytes([]byte("old")).Revision})
				}
				after := handleFileID(t, target)
				data, _ := os.ReadFile(target)
				if failure == nil || failure.code != "revision_conflict" || string(data) != "rival" || !sameFileID(before, after) {
					t.Fatalf("failure=%#v content=%q", failure, data)
				}
				requireNoHelperEntries(t, home)
			})
		}
	}
}

func TestWindowsDeleteAndAppendBarrierFailuresAreIO(t *testing.T) {
	for _, injected := range windowsBarrierErrors {
		for _, operation := range []string{"delete-first", "delete-second", "append-file", "append-parent"} {
			t.Run(injected.name+"/"+operation, func(t *testing.T) {
				_, active := pinnedNTFSSession(t)
				failAt := 1
				if operation == "delete-second" || operation == "append-parent" {
					failAt = 2
				}
				spy := spyBarriers(t, injected.errno, func(call int, _ bool) bool { return call == failAt })
				var failure *protocolError
				if strings.HasPrefix(operation, "delete") {
					_, failure = active.delete(deleteRequest{ID: "delete", Protocol: protocolVersion, Op: "delete", Path: "MEMORY.md", ExpectedRevision: stateForBytes([]byte("old")).Revision})
				} else {
					_, failure = active.append(appendRequest{ID: "append", Protocol: protocolVersion, Op: "append", Path: "notes/new.md", Content: "new", MaxBytes: 1024})
				}
				if failure == nil || failure.code != "io_failure" || len(spy.order) != failAt || spy.injected != 1 {
					t.Fatalf("failure=%#v order=%v injected=%d", failure, spy.order, spy.injected)
				}
			})
		}
	}
}

// Go opens an O_APPEND file without FILE_WRITE_DATA, so an append to an
// existing note flushes through a handle that has only FILE_APPEND_DATA.
// No barrier is injected here: every flush is real and must succeed.
func TestWindowsAppendRunsRealBarriersOnNTFS(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "new"
		if existing {
			name = "existing"
		}
		t.Run(name, func(t *testing.T) {
			home, active := pinnedNTFSSession(t)
			target := filepath.Join(home, "notes", "log.md")
			if existing {
				if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			spy := spyBarriers(t, 0, func(int, bool) bool { return false })
			if _, failure := active.append(appendRequest{ID: "append", Protocol: protocolVersion, Op: "append", Path: "notes/log.md", Content: "+new", MaxBytes: 1024}); failure != nil {
				t.Fatalf("append failed: %#v order=%v", failure, spy.order)
			}
			expected, order := "+new", "temp,parent"
			if existing {
				expected, order = "old+new", "temp"
			}
			data, _ := os.ReadFile(target)
			if string(data) != expected || strings.Join(spy.order, ",") != order {
				t.Fatalf("content=%q order=%v", data, spy.order)
			}
		})
	}
}

func TestWindowsLedgerReplaceStrictOrderAndFailureWindows(t *testing.T) {
	for _, window := range []string{"success", "temp", "parent"} {
		t.Run(window, func(t *testing.T) {
			home, active := pinnedNTFSSession(t)
			if err := os.Mkdir(filepath.Join(home, ".byok"), 0o700); err != nil {
				t.Fatal(err)
			}
			spy := spyBarriers(t, syscall.ERROR_ACCESS_DENIED, func(_ int, directory bool) bool {
				return (window == "temp" && !directory) || (window == "parent" && directory)
			})
			_, failure := active.replace(injectedReplace(".byok/agent-memory-intents-v1.json", "", "applying"))
			target := filepath.Join(home, ".byok", "agent-memory-intents-v1.json")
			content, readErr := os.ReadFile(target)
			order := strings.Join(spy.order, ",")
			if window == "success" {
				if failure != nil || string(content) != "applying" || order != "temp,parent" {
					t.Fatalf("failure=%#v order=%v content=%q", failure, order, content)
				}
			} else {
				if failure == nil || failure.code != "io_failure" {
					t.Fatalf("failure=%#v", failure)
				}
				if window == "temp" && (!os.IsNotExist(readErr) || order != "temp") {
					t.Fatal("temp failure published ledger or fell back")
				}
				if window == "parent" && (string(content) != "applying" || order != "temp,parent") {
					t.Fatal("parent failure lost the visible uncertain boundary")
				}
			}
			requireNoHelperEntries(t, filepath.Join(home, ".byok"))
		})
	}
}
