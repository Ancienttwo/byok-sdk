package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

func TestProtocolFourRequiresExplicitAncestor(t *testing.T) {
	home := newMemoryHome(t)
	base := func() map[string]any {
		return map[string]any{"id": "open", "protocol": 4, "op": "open", "root": home,
			"ancestorRoot": filepath.Dir(home), "expectedIdentity": identityForTest(t, home)}
	}
	for _, version := range []int{0, 1, 2, 3, 5} {
		t.Run("protocol-"+strconv.Itoa(version), func(t *testing.T) {
			helper := startHelper(t)
			req := base()
			req["protocol"] = version
			requireFailure(t, helper.request(req), "malformed_request")
			requireSuccess(t, helper.request(base()))
			helper.close()
		})
	}
	for _, fixture := range []string{"missing", "null", "empty", "relative", "sibling"} {
		t.Run(fixture, func(t *testing.T) {
			helper := startHelper(t)
			req := base()
			code := "invalid_root"
			switch fixture {
			case "missing":
				delete(req, "ancestorRoot")
				code = "malformed_request"
			case "null":
				req["ancestorRoot"] = nil
				code = "malformed_request"
			case "empty":
				req["ancestorRoot"] = ""
			case "relative":
				req["ancestorRoot"] = "agents"
			case "sibling":
				req["ancestorRoot"] = t.TempDir()
			}
			requireFailure(t, helper.request(req), code)
			requireSuccess(t, helper.request(base()))
			helper.close()
		})
	}
}

func TestOpenRequiresEveryChainAndInitializationFlush(t *testing.T) {
	ancestor, home, root := explicitRootFixture(t)
	for _, name := range []string{".byok", "notes"} {
		if err := os.Mkdir(filepath.Join(home, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	identity := identityForTest(t, home)
	req := openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, AncestorRoot: ancestor, ExpectedIdentity: identity}
	original := strictSync
	t.Cleanup(func() { strictSync = original })
	var flushed []os.FileInfo
	strictSync = func(file *os.File) error {
		info, err := file.Stat()
		if err != nil {
			return err
		}
		flushed = append(flushed, info)
		return original(file)
	}
	active, failure := openSession(req)
	if failure != nil {
		t.Fatalf("baseline open: %#v", failure)
	}
	_ = active.root.Close()
	if runtime.GOOS == "windows" && len(flushed) != 12 {
		t.Fatalf("flush count=%d, want 8 chain + 4 initialization", len(flushed))
	}
	for index, name := range []string{".byok", ".", "notes", "."} {
		info, err := root.Stat(name)
		if err != nil || !os.SameFile(info, flushed[len(flushed)-4+index]) {
			t.Fatalf("initialization flush %d did not flush %s: %v", index, name, err)
		}
	}
	for failAt := 1; failAt <= len(flushed); failAt++ {
		t.Run(strconv.Itoa(failAt), func(t *testing.T) {
			calls := 0
			strictSync = func(file *os.File) error {
				calls++
				if calls == failAt {
					return errors.New("injected flush failure")
				}
				return original(file)
			}
			opened, failure := openSession(req)
			if opened != nil || failure == nil || failure.code != "io_failure" || calls != failAt {
				t.Fatalf("session=%v failure=%#v calls=%d want=%d", opened, failure, calls, failAt)
			}
		})
	}
	strictSync = original
	active, failure = openSession(req)
	if failure != nil {
		t.Fatalf("failed open retained authority or skipped recovery barrier: %#v", failure)
	}
	_ = active.root.Close()
}
