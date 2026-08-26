//go:build !windows

package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestHelperProcess(t *testing.T) {
	if os.Getenv("AGENT_MEMORY_FS_HELPER_PROCESS") != "1" {
		return
	}
	if err := runCLI([]string{"serve"}, os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

type wireResponse struct {
	ID       string          `json:"id"`
	OK       bool            `json:"ok"`
	Protocol int             `json:"protocol"`
	Result   json.RawMessage `json:"result"`
	Error    *responseError  `json:"error"`
}

type helperProcess struct {
	t      *testing.T
	cmd    *exec.Cmd
	input  io.WriteCloser
	output *bufio.Reader
	nextID int
	closed bool
}

func TestVersionAndOpenProtocol(t *testing.T) {
	var output bytes.Buffer
	if err := runCLI([]string{"--version"}, strings.NewReader(""), &output); err != nil {
		t.Fatalf("--version: %v", err)
	}
	if got := output.String(); got != helperVersion+"\n" {
		t.Fatalf("version = %q", got)
	}

	home := newMemoryHome(t)
	helper := startHelper(t)
	open := helper.request(map[string]any{
		"id":               "open",
		"protocol":         protocolVersion,
		"op":               "open",
		"root":             home,
		"expectedIdentity": identityForTest(t, home),
	})
	requireSuccess(t, open)
	var result openResult
	decodeResult(t, open, &result)
	if result.HelperVersion != helperVersion || result.Identity != identityForTest(t, home) {
		t.Fatalf("open result = %#v", result)
	}
	helper.close()
}

func TestOpenRejectsMismatchedTaggedIdentity(t *testing.T) {
	home := newMemoryHome(t)
	expected := identityForTest(t, home)
	expected.Ino = "0"
	helper := startHelper(t)
	response := helper.request(map[string]any{
		"id":               "wrong-identity",
		"protocol":         protocolVersion,
		"op":               "open",
		"root":             home,
		"expectedIdentity": expected,
	})
	requireFailure(t, response, "root_identity_mismatch")
	if strings.Contains(response.Error.Message, home) {
		t.Fatalf("root mismatch error leaked absolute root: %#v", response.Error)
	}
	helper.stop()
}

func TestServeRejectsMalformedRequestWithoutLeakingInput(t *testing.T) {
	home := newMemoryHome(t)
	helper := startHelper(t)
	response := helper.request(map[string]any{
		"id":       "bad",
		"protocol": protocolVersion,
		"op":       "open",
		"root":     home,
		"content":  "private-content-must-not-echo",
	})
	requireFailure(t, response, "malformed_request")
	if strings.Contains(response.Error.Message, home) || strings.Contains(response.Error.Message, "private-content") {
		t.Fatalf("malformed request error leaked input: %#v", response.Error)
	}

	open := helper.open(home)
	requireSuccess(t, open)
	helper.close()
}

func TestPathRejection(t *testing.T) {
	home := newMemoryHome(t)
	helper := startOpenedHelper(t, home)
	for _, value := range []string{"", ".", "..", "../outside", "/absolute", "notes\\entry.md", "notes//entry.md", "notes/./entry.md", "notes/../entry.md"} {
		response := helper.request(map[string]any{
			"id":       helper.id("reject"),
			"protocol": protocolVersion,
			"op":       "read",
			"path":     value,
			"maxBytes": 128,
		})
		requireFailure(t, response, "invalid_request")
	}
	helper.close()
}

func TestReplaceCASAndAtomicDelete(t *testing.T) {
	home := newMemoryHome(t)
	path := filepath.Join(home, "notes", "entry.md")
	if err := os.WriteFile(path, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	helper := startOpenedHelper(t, home)
	before := helper.read("notes/entry.md", maxFileBytes)
	requireSuccess(t, before)
	var initial fileState
	decodeResult(t, before, &initial)

	wrong := helper.request(map[string]any{
		"id":               helper.id("wrong-cas"),
		"protocol":         protocolVersion,
		"op":               "replace",
		"path":             "notes/entry.md",
		"expectedRevision": emptyFileState().Revision,
		"contentBase64":    base64.RawStdEncoding.EncodeToString([]byte("replacement")),
		"maxBytes":         maxFileBytes,
	})
	requireFailure(t, wrong, "revision_conflict")
	if wrong.Error.ActualRevision != initial.Revision {
		t.Fatalf("actual revision = %q, want %q", wrong.Error.ActualRevision, initial.Revision)
	}

	replaced := helper.request(map[string]any{
		"id":               helper.id("replace"),
		"protocol":         protocolVersion,
		"op":               "replace",
		"path":             "notes/entry.md",
		"expectedRevision": initial.Revision,
		"contentBase64":    base64.RawStdEncoding.EncodeToString([]byte("replacement")),
		"maxBytes":         maxFileBytes,
	})
	requireSuccess(t, replaced)
	var current fileState
	decodeResult(t, replaced, &current)
	if !current.Exists || decodedContent(t, current) != "replacement" || current.Revision == initial.Revision {
		t.Fatalf("replacement state = %#v", current)
	}
	if disk, err := os.ReadFile(path); err != nil || string(disk) != "replacement" {
		t.Fatalf("replacement was not atomically visible: %q, %v", disk, err)
	}

	deleted := helper.request(map[string]any{
		"id":               helper.id("delete"),
		"protocol":         protocolVersion,
		"op":               "delete",
		"path":             "notes/entry.md",
		"expectedRevision": current.Revision,
	})
	requireSuccess(t, deleted)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("delete did not remove entry: %v", err)
	}
	helper.close()
}

func TestReplaceRequiresV2Base64Wire(t *testing.T) {
	home := newMemoryHome(t)
	helper := startOpenedHelper(t, home)
	before := helper.read("MEMORY.md", maxFileBytes)
	requireSuccess(t, before)
	var initial fileState
	decodeResult(t, before, &initial)

	legacy := helper.request(map[string]any{
		"id":               helper.id("legacy-raw-content"),
		"protocol":         protocolVersion,
		"op":               "replace",
		"path":             "MEMORY.md",
		"expectedRevision": initial.Revision,
		"content":          "must-not-be-accepted",
		"maxBytes":         maxFileBytes,
	})
	requireFailure(t, legacy, "malformed_request")

	malformedBase64 := helper.request(map[string]any{
		"id":               helper.id("malformed-base64"),
		"protocol":         protocolVersion,
		"op":               "replace",
		"path":             "MEMORY.md",
		"expectedRevision": initial.Revision,
		"contentBase64":    "%%%",
		"maxBytes":         maxFileBytes,
	})
	requireFailure(t, malformedBase64, "invalid_request")

	helper.close()
}

func TestAppendAndWalk(t *testing.T) {
	home := newMemoryHome(t)
	if err := os.WriteFile(filepath.Join(home, "notes", "one.md"), []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(home, "notes", "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "notes", "nested", "two.md"), []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	helper := startOpenedHelper(t, home)
	appended := helper.request(map[string]any{
		"id":       helper.id("append"),
		"protocol": protocolVersion,
		"op":       "append",
		"path":     "notes/one.md",
		"content":  "+more",
		"maxBytes": maxFileBytes,
	})
	requireSuccess(t, appended)
	var state fileState
	decodeResult(t, appended, &state)
	if state.ContentBase64 != "" || state.ByteCount != len("one+more") {
		t.Fatalf("append state = %#v", state)
	}

	walked := helper.request(map[string]any{
		"id":         helper.id("walk"),
		"protocol":   protocolVersion,
		"op":         "walk",
		"path":       "notes",
		"maxEntries": 8,
	})
	requireSuccess(t, walked)
	var result walkResult
	decodeResult(t, walked, &result)
	want := []string{"notes/nested/two.md", "notes/one.md"}
	if !reflect.DeepEqual(result.Paths, want) {
		t.Fatalf("walk paths = %#v, want %#v", result.Paths, want)
	}
	helper.close()
}

func TestMaximumReadResponseIsBounded(t *testing.T) {
	home := newMemoryHome(t)
	content := strings.Repeat("\x00", maxFileBytes)
	if err := os.WriteFile(filepath.Join(home, "notes", "bounded.md"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	helper := startOpenedHelper(t, home)
	response := helper.read("notes/bounded.md", maxFileBytes)
	requireSuccess(t, response)
	if len(response.Result) > maxResponseJSONLineBytes {
		t.Fatalf("read result exceeded protocol bound: %d", len(response.Result))
	}
	var state fileState
	decodeResult(t, response, &state)
	decoded, decodeErr := base64.RawStdEncoding.DecodeString(state.ContentBase64)
	if decodeErr != nil || state.ByteCount != maxFileBytes || string(decoded) != content {
		t.Fatalf("bounded read state has %d bytes", state.ByteCount)
	}
	helper.close()
}

func TestRootParentAndLeafSymlinkSwapsCannotTouchOutsideSentinel(t *testing.T) {
	t.Run("root", func(t *testing.T) {
		parent := t.TempDir()
		home := filepath.Join(parent, "home")
		outside := filepath.Join(parent, "outside")
		if err := os.MkdirAll(filepath.Join(home, "notes"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(outside, 0o700); err != nil {
			t.Fatal(err)
		}
		sentinel := filepath.Join(outside, "sentinel")
		if err := os.WriteFile(sentinel, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		expected := identityForTest(t, home)
		if err := os.Rename(home, filepath.Join(parent, "old-home")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, home); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		helper := startHelper(t)
		response := helper.request(map[string]any{
			"id":               "open-root-swap",
			"protocol":         protocolVersion,
			"op":               "open",
			"root":             home,
			"expectedIdentity": expected,
		})
		if response.OK || (response.Error.Code != "unsafe_root" && response.Error.Code != "root_identity_mismatch") {
			t.Fatalf("root swap response = %#v", response)
		}
		assertSentinel(t, sentinel, "outside")
		helper.stop()
	})

	t.Run("parent", func(t *testing.T) {
		home := newMemoryHome(t)
		outside := filepath.Join(t.TempDir(), "outside")
		if err := os.MkdirAll(outside, 0o700); err != nil {
			t.Fatal(err)
		}
		sentinel := filepath.Join(outside, "entry.md")
		if err := os.WriteFile(sentinel, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		helper := startOpenedHelper(t, home)
		if err := os.Rename(filepath.Join(home, "notes"), filepath.Join(home, "notes-real")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(home, "notes")); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		response := helper.request(map[string]any{
			"id":               helper.id("parent-swap"),
			"protocol":         protocolVersion,
			"op":               "replace",
			"path":             "notes/entry.md",
			"expectedRevision": emptyFileState().Revision,
			"contentBase64":    base64.RawStdEncoding.EncodeToString([]byte("must-not-write-outside")),
			"maxBytes":         maxFileBytes,
		})
		requireFailure(t, response, "unsafe_path")
		assertSentinel(t, sentinel, "outside")
		helper.close()
	})

	t.Run("leaf", func(t *testing.T) {
		home := newMemoryHome(t)
		entry := filepath.Join(home, "notes", "entry.md")
		if err := os.WriteFile(entry, []byte("inside"), 0o600); err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "outside")
		if err := os.MkdirAll(outside, 0o700); err != nil {
			t.Fatal(err)
		}
		sentinel := filepath.Join(outside, "sentinel")
		if err := os.WriteFile(sentinel, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		helper := startOpenedHelper(t, home)
		state := helper.read("notes/entry.md", maxFileBytes)
		requireSuccess(t, state)
		var before fileState
		decodeResult(t, state, &before)
		if err := os.Remove(entry); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(sentinel, entry); err != nil {
			t.Skipf("symlink unavailable: %v", err)
		}
		response := helper.request(map[string]any{
			"id":               helper.id("leaf-swap"),
			"protocol":         protocolVersion,
			"op":               "replace",
			"path":             "notes/entry.md",
			"expectedRevision": before.Revision,
			"contentBase64":    base64.RawStdEncoding.EncodeToString([]byte("must-not-write-outside")),
			"maxBytes":         maxFileBytes,
		})
		requireFailure(t, response, "unsafe_path")
		assertSentinel(t, sentinel, "outside")
		helper.close()
	})
}

func TestHelperDeathIsObservable(t *testing.T) {
	home := newMemoryHome(t)
	helper := startOpenedHelper(t, home)
	if err := helper.cmd.Process.Kill(); err != nil {
		t.Fatalf("kill helper: %v", err)
	}
	if err := helper.cmd.Wait(); err == nil {
		t.Fatal("helper death unexpectedly returned success")
	}
	helper.closed = true
}

func startOpenedHelper(t *testing.T, home string) *helperProcess {
	t.Helper()
	helper := startHelper(t)
	response := helper.open(home)
	requireSuccess(t, response)
	return helper
}

func startHelper(t *testing.T) *helperProcess {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=TestHelperProcess")
	command.Env = append(os.Environ(), "AGENT_MEMORY_FS_HELPER_PROCESS=1")
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	helper := &helperProcess{t: t, cmd: command, input: input, output: bufio.NewReader(output)}
	t.Cleanup(func() { helper.stop() })
	return helper
}

func (h *helperProcess) id(prefix string) string {
	h.nextID++
	return prefix + "-" + strconv.Itoa(h.nextID)
}

func (h *helperProcess) open(home string) wireResponse {
	return h.request(map[string]any{
		"id":               h.id("open"),
		"protocol":         protocolVersion,
		"op":               "open",
		"root":             home,
		"expectedIdentity": identityForTest(h.t, home),
	})
}

func (h *helperProcess) read(path string, maximum int) wireResponse {
	return h.request(map[string]any{
		"id":       h.id("read"),
		"protocol": protocolVersion,
		"op":       "read",
		"path":     path,
		"maxBytes": maximum,
	})
}

func (h *helperProcess) request(value any) wireResponse {
	h.t.Helper()
	if h.closed {
		h.t.Fatal("request after helper close")
	}
	line, err := json.Marshal(value)
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.input.Write(append(line, '\n')); err != nil {
		h.t.Fatal(err)
	}
	responseLine, err := h.output.ReadBytes('\n')
	if err != nil {
		h.t.Fatal(err)
	}
	if len(responseLine) > maxResponseJSONLineBytes {
		h.t.Fatalf("response exceeded frame limit: %d", len(responseLine))
	}
	var decoded wireResponse
	if err := json.Unmarshal(responseLine, &decoded); err != nil {
		h.t.Fatalf("invalid response %q: %v", responseLine, err)
	}
	return decoded
}

func (h *helperProcess) close() {
	h.t.Helper()
	if h.closed {
		return
	}
	response := h.request(map[string]any{"id": h.id("close"), "protocol": protocolVersion, "op": "close"})
	requireSuccess(h.t, response)
	if err := h.input.Close(); err != nil {
		h.t.Fatal(err)
	}
	if err := h.cmd.Wait(); err != nil {
		h.t.Fatalf("helper close: %v", err)
	}
	h.closed = true
}

func (h *helperProcess) stop() {
	if h.closed {
		return
	}
	_ = h.input.Close()
	_ = h.cmd.Process.Kill()
	_ = h.cmd.Wait()
	h.closed = true
}

func identityForTest(t *testing.T, home string) rootIdentity {
	t.Helper()
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	info, err := root.Stat(".")
	if err != nil {
		t.Fatal(err)
	}
	identity, err := identityForRoot(root, info)
	if err != nil {
		t.Fatal(err)
	}
	return identity
}

func newMemoryHome(t *testing.T) string {
	t.Helper()
	home := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(filepath.Join(home, "notes"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "MEMORY.md"), []byte("memory"), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func requireSuccess(t *testing.T, response wireResponse) {
	t.Helper()
	if !response.OK || response.Protocol != protocolVersion || response.Error != nil {
		t.Fatalf("response was not successful: %#v", response)
	}
}

func requireFailure(t *testing.T, response wireResponse, code string) {
	t.Helper()
	if response.OK || response.Protocol != protocolVersion || response.Error == nil || response.Error.Code != code {
		t.Fatalf("response failure = %#v, want code %q", response, code)
	}
}

func decodeResult(t *testing.T, response wireResponse, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Result, target); err != nil {
		t.Fatalf("decode result %q: %v", response.Result, err)
	}
}

func decodedContent(t *testing.T, state fileState) string {
	t.Helper()
	decoded, err := base64.RawStdEncoding.DecodeString(state.ContentBase64)
	if err != nil {
		t.Fatalf("decode content: %v", err)
	}
	return string(decoded)
}

func assertSentinel(t *testing.T, path string, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || string(got) != want {
		t.Fatalf("outside sentinel = %q, %v; want %q", got, err, want)
	}
}
