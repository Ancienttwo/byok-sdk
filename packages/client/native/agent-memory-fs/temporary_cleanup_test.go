package main

import (
	"bufio"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func cleanupSession(t *testing.T, home string) *session {
	t.Helper()
	active, err := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identityForTest(t, home)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = active.root.Close() })
	return active
}

func cleanupWrite(active *session, operation, path, before string) *protocolError {
	switch operation {
	case "replace":
		_, err := active.replace(replaceRequest{ID: "replace", Protocol: protocolVersion, Op: "replace", Path: path,
			ExpectedRevision: stateForBytes([]byte(before)).Revision, ContentBase64: base64.RawStdEncoding.EncodeToString([]byte("next")), MaxBytes: maxFileBytes})
		return err
	case "delete":
		_, err := active.delete(deleteRequest{ID: "delete", Protocol: protocolVersion, Op: "delete", Path: path, ExpectedRevision: stateForBytes([]byte(before)).Revision})
		return err
	default:
		_, err := active.append(appendRequest{ID: "append", Protocol: protocolVersion, Op: "append", Path: path, Content: "next", MaxBytes: maxFileBytes})
		return err
	}
}

// These fixtures are the exact reserved names left by a killed helper. A
// matching prefix alone is insufficient authority to delete a user's file.
func TestTemporaryCleanupOnNextWrite(t *testing.T) {
	for _, directory := range []string{"", "notes", ".byok", "notes/nested"} {
		for _, operation := range []string{"replace", "delete", "append"} {
			t.Run(directory+"/"+operation, func(t *testing.T) {
				home := newMemoryHome(t)
				parent := filepath.Join(home, directory)
				if err := os.MkdirAll(parent, 0700); err != nil {
					t.Fatal(err)
				}
				for _, kind := range []string{"replace", "delete"} {
					if err := os.WriteFile(filepath.Join(parent, temporaryName(kind)), []byte("abandoned"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				keep := []string{".byok-agent-memory-replace-user.tmp", ".byok-agent-memory-delete-" + strings.Repeat("A", 32) + ".tmp", ".byok-agent-memory-other-" + strings.Repeat("a", 32) + ".tmp", "user.md"}
				for _, name := range keep {
					if err := os.WriteFile(filepath.Join(parent, name), []byte("keep"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				target := filepath.Join(directory, "target.md")
				if err := os.WriteFile(filepath.Join(home, target), []byte("old"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := cleanupWrite(cleanupSession(t, home), operation, filepath.ToSlash(target), "old"); err != nil {
					t.Fatal(err)
				}
				entries, err := os.ReadDir(parent)
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range entries {
					for _, kind := range []string{"replace", "delete"} {
						if strings.HasPrefix(entry.Name(), ".byok-agent-memory-"+kind+"-") && !containsName(keep, entry.Name()) {
							t.Errorf("abandoned helper temp remains: %s", entry.Name())
						}
					}
				}
				for _, name := range keep {
					if data, err := os.ReadFile(filepath.Join(parent, name)); err != nil || string(data) != "keep" {
						t.Errorf("unrelated file %s: %q %v", name, data, err)
					}
				}
			})
		}
	}
}

func containsName(names []string, name string) bool {
	for _, candidate := range names {
		if candidate == name {
			return true
		}
	}
	return false
}

func TestTemporaryCleanupFailsClosed(t *testing.T) {
	for _, fixture := range []string{"directory", "hardlink", "link-symlink", "flush"} {
		t.Run(fixture, func(t *testing.T) {
			home := newMemoryHome(t)
			active := cleanupSession(t, home)
			temporary := filepath.Join(home, temporaryName("replace"))
			sentinel := filepath.Join(t.TempDir(), "sentinel")
			if err := os.WriteFile(sentinel, []byte("outside"), 0600); err != nil {
				t.Fatal(err)
			}
			switch fixture {
			case "directory":
				if err := os.Mkdir(temporary, 0700); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(sentinel, temporary); err != nil {
					t.Fatal(err)
				}
			case "link-symlink":
				if err := os.Symlink(sentinel, temporary); err != nil {
					t.Fatal(err)
				}
			case "flush":
				if err := os.WriteFile(temporary, []byte("abandoned"), 0600); err != nil {
					t.Fatal(err)
				}
				original := strictSync
				t.Cleanup(func() { strictSync = original })
				strictSync = func(*os.File) error { return errors.New("injected cleanup flush failure") }
			}
			failure := cleanupWrite(active, "append", "MEMORY.md", "memory")
			want := "unsafe_path"
			if fixture == "flush" {
				want = "io_failure"
			}
			if failure == nil || failure.code != want {
				t.Fatalf("failure=%v want=%s", failure, want)
			}
			if data, err := os.ReadFile(filepath.Join(home, "MEMORY.md")); err != nil || string(data) != "memory" {
				t.Fatalf("target changed: %q %v", data, err)
			}
			if data, err := os.ReadFile(sentinel); err != nil || string(data) != "outside" {
				t.Fatalf("outside changed: %q %v", data, err)
			}
		})
	}
}

func TestTemporaryCleanupDoesNotRunForReaders(t *testing.T) {
	home := newMemoryHome(t)
	temporary := temporaryName("replace")
	if err := os.WriteFile(filepath.Join(home, temporary), []byte("abandoned"), 0600); err != nil {
		t.Fatal(err)
	}
	helper := startOpenedHelper(t, home)
	requireSuccess(t, helper.read("MEMORY.md", maxFileBytes))
	requireFailure(t, helper.read(temporary, maxFileBytes), "invalid_request")
	helper.close()
	if data, err := os.ReadFile(filepath.Join(home, temporary)); err != nil || string(data) != "abandoned" {
		t.Fatalf("reader changed temporary: %q %v", data, err)
	}
}

func TestTemporaryCleanupCrashChild(t *testing.T) {
	home := os.Getenv("BYOK_TEST_TEMP_CLEANUP_HOME")
	if home == "" {
		return
	}
	active := cleanupSession(t, home)
	operation := os.Getenv("BYOK_TEST_TEMP_CLEANUP_OPERATION")
	// Stop at an actual helper write boundary, without unwinding its defers.
	original := strictSync
	strictSync = func(file *os.File) error {
		info, err := file.Stat()
		if err != nil {
			return err
		}
		if (operation == "delete") == info.IsDir() {
			fmt.Println("temporary-ready")
			select {}
		}
		return original(file)
	}
	if err := cleanupWrite(active, operation, "MEMORY.md", "memory"); err != nil {
		t.Fatal(err)
	}
	t.Fatal("crash boundary was not reached")
}

func TestTemporaryCleanupAfterProcessKill(t *testing.T) {
	for _, operation := range []string{"replace", "delete"} {
		t.Run(operation, func(t *testing.T) {
			home := newMemoryHome(t)
			child := exec.Command(os.Args[0], "-test.run=^TestTemporaryCleanupCrashChild$")
			child.Env = append(os.Environ(), "BYOK_TEST_TEMP_CLEANUP_HOME="+home, "BYOK_TEST_TEMP_CLEANUP_OPERATION="+operation)
			output, err := child.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = child.Process.Kill() })
			ready := make(chan string, 1)
			go func() { line, _ := bufio.NewReader(output).ReadString('\n'); ready <- line }()
			select {
			case line := <-ready:
				if line != "temporary-ready\n" {
					_ = child.Process.Kill()
					_ = child.Wait()
					t.Fatalf("child: %q", line)
				}
			case <-time.After(15 * time.Second):
				_ = child.Process.Kill()
				_ = child.Wait()
				t.Fatal("child did not reach the write boundary")
			}
			if err := child.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := child.Wait(); err == nil {
				t.Fatal("child was not killed")
			}
			entries, err := filepath.Glob(filepath.Join(home, ".byok-agent-memory-*.tmp"))
			if err != nil || len(entries) != 1 {
				t.Fatalf("killed write leftovers=%v err=%v", entries, err)
			}
			// A different next write must reclaim debris without restoring a
			// deleted target or publishing an incomplete replacement.
			helper := startOpenedHelper(t, home)
			requireSuccess(t, helper.request(map[string]any{"id": "next", "protocol": protocolVersion, "op": "append", "path": "next.md", "content": "next", "maxBytes": maxFileBytes}))
			helper.close()
			if _, err := os.Lstat(entries[0]); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("abandoned helper temp remains: %v", err)
			}
			data, err := os.ReadFile(filepath.Join(home, "MEMORY.md"))
			if operation == "replace" && (err != nil || string(data) != "memory") {
				t.Fatalf("uncommitted replace became visible: %q %v", data, err)
			}
			if operation == "delete" && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("deleted target was restored: %q %v", data, err)
			}
		})
	}
}
