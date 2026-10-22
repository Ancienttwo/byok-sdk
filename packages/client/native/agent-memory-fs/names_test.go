package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
)

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

func openNamesSession(t *testing.T, home string) *session {
	t.Helper()
	active, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identityForTest(t, home)})
	if failure != nil {
		t.Fatalf("open failed: %v", failure)
	}
	t.Cleanup(func() { _ = active.root.Close() })
	return active
}

func walkNames(t *testing.T, active *session, maxEntries int) ([]string, *protocolError) {
	t.Helper()
	result, failure := active.walk(walkRequest{ID: "walk", Protocol: protocolVersion, Op: "walk", Path: "notes", MaxEntries: maxEntries})
	return result.Paths, failure
}

// literalPath keeps a name exactly as written. Without the \\?\ prefix,
// Windows drops a trailing dot and maps a device name.
func literalPath(directory, name string) string {
	target := filepath.Join(directory, name)
	if runtime.GOOS == "windows" && !strings.HasPrefix(target, `\\?\`) {
		target = `\\?\` + target
	}
	return target
}

// writeLiteral and mkdirLiteral also remove the fixture through its literal
// path. t.TempDir removes paths without the prefix and can miss these names.
func writeLiteral(t *testing.T, directory, name, content string) {
	t.Helper()
	target := literalPath(directory, name)
	if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(target) })
	requireEntry(t, directory, name)
}

func mkdirLiteral(t *testing.T, directory, name string) string {
	t.Helper()
	target := literalPath(directory, name)
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(target) })
	requireEntry(t, directory, name)
	return target
}

// requireEntry proves the fixture has the exact name, so a test cannot pass
// against a name the platform changed.
func requireEntry(t *testing.T, directory, name string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() == name {
			return
		}
	}
	t.Fatalf("fixture %q is missing from %s", name, directory)
}

func TestPortableSegmentRefusesWindowsAliasNames(t *testing.T) {
	for _, name := range []string{"CON", "con", "CON.md", "nul.x.md", "Aux", "prn.txt", "COM0", "com9.md", "LPT5", "lpt0.md", "COM\u00b9", "CONIN$", "conout$.md", "con .md", "x.", "notes.", "a.md.", "a ", "a.md "} {
		if portableSegment(name) {
			t.Errorf("portableSegment(%q) = true, want false", name)
		}
	}
	for _, name := range []string{"CONSOLE.md", "COM10", "LPT", "com.md", "x.md", "nul-x.md", "auxiliary.md", "a.b", ".byok", "MEMORY.md"} {
		if !portableSegment(name) {
			t.Errorf("portableSegment(%q) = false, want true", name)
		}
	}
}

func TestRequestsRefuseWindowsAliasNames(t *testing.T) {
	active := openNamesSession(t, newMemoryHome(t))
	for _, path := range []string{"notes/CON.md", "notes/con", "notes/nul.x.md", "notes/x./a.md", "notes/a.md.", "notes/a "} {
		for _, operation := range []string{"read", "replace", "delete", "append", "walk"} {
			if failure := pinnedOperation(active, operation, path, emptyFileState().Revision); failure == nil || failure.code != "invalid_request" {
				t.Errorf("%s %q = %v, want invalid_request", operation, path, failure)
			}
		}
	}
}

func TestWalkLeavesOutWindowsAliasNames(t *testing.T) {
	home := newMemoryHome(t)
	notes := filepath.Join(home, "notes")
	writeLiteral(t, notes, "CON.md", "device")
	writeLiteral(t, notes, "nul.x.md", "device")
	writeLiteral(t, notes, "trailing.md.", "dot")
	dotted := mkdirLiteral(t, notes, "x.")
	writeLiteral(t, dotted, "inner.md", "inner")
	writeLiteral(t, notes, "plain.md", "plain")
	active := openNamesSession(t, home)

	// Five entries in notes. The dotted directory is not entered, so its
	// file is not counted.
	paths, failure := walkNames(t, active, 5)
	if failure != nil || !reflect.DeepEqual(paths, []string{"notes/plain.md"}) {
		t.Fatalf("walk = %v, %v; want only notes/plain.md", paths, failure)
	}
	if _, failure := walkNames(t, active, 4); failure == nil || failure.code != "entry_limit" {
		t.Fatalf("walk with 4 entries = %v, want entry_limit: left-out names still count", failure)
	}
}

func TestNamesThatDifferOnlyInCaseAreRefused(t *testing.T) {
	home := newMemoryHome(t)
	notes := filepath.Join(home, "notes")
	writeLiteral(t, notes, "Upper.md", "upper")
	upperDirectory := mkdirLiteral(t, notes, "Dir")
	writeLiteral(t, upperDirectory, "a.md", "nested")
	_, statErr := os.Lstat(filepath.Join(notes, "UPPER.md"))
	caseInsensitive := statErr == nil
	if !caseInsensitive {
		// A case-sensitive volume holds both names. Neither one is usable.
		writeLiteral(t, notes, "upper.md", "lower")
	}
	active := openNamesSession(t, home)

	refused := []string{"notes/upper.md", "notes/UPPER.md", "notes/dir/a.md", "notes/DIR/a.md"}
	if !caseInsensitive {
		refused = append(refused, "notes/Upper.md")
	}
	for _, path := range refused {
		for _, operation := range []string{"read", "replace", "delete", "append"} {
			if failure := pinnedOperation(active, operation, path, emptyFileState().Revision); failure == nil || failure.code != "unsafe_path" {
				t.Errorf("%s %q = %v, want unsafe_path", operation, path, failure)
			}
		}
	}
	want := []string{"notes/Dir/a.md"}
	if caseInsensitive {
		// An existing name with upper case stays usable when it has no alias.
		if state, failure := active.read(readRequest{ID: "read", Protocol: protocolVersion, Op: "read", Path: "notes/Upper.md", MaxBytes: maxFileBytes}); failure != nil || !state.Exists {
			t.Fatalf("read notes/Upper.md = %#v, %v", state, failure)
		}
		want = []string{"notes/Dir/a.md", "notes/Upper.md"}
	}
	if paths, failure := walkNames(t, active, 8); failure != nil || !reflect.DeepEqual(paths, want) {
		t.Fatalf("walk = %v, %v; want %v", paths, failure, want)
	}
	for name, content := range map[string]string{"Upper.md": "upper", filepath.Join("Dir", "a.md"): "nested"} {
		if data, err := os.ReadFile(filepath.Join(notes, name)); err != nil || string(data) != content {
			t.Fatalf("%s changed: %q, %v", name, data, err)
		}
	}
}

func TestHardLinkedFilesAreRefusedAndLeftOutOfWalk(t *testing.T) {
	home := newMemoryHome(t)
	notes := filepath.Join(home, "notes")
	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, []byte("outside sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(notes, "linked.md")); err != nil {
		t.Fatalf("hard link setup failed: %v", err)
	}
	writeLiteral(t, notes, "first.md", "twin")
	if err := os.Link(filepath.Join(notes, "first.md"), filepath.Join(notes, "second.md")); err != nil {
		t.Fatalf("hard link setup failed: %v", err)
	}
	writeLiteral(t, notes, "plain.md", "plain")
	active := openNamesSession(t, home)
	outsideRevision := stateForBytes([]byte("outside sentinel")).Revision

	for _, path := range []string{"notes/linked.md", "notes/first.md", "notes/second.md"} {
		for _, operation := range []string{"read", "replace", "delete", "append"} {
			revision := outsideRevision
			if path != "notes/linked.md" {
				revision = stateForBytes([]byte("twin")).Revision
			}
			if failure := pinnedOperation(active, operation, path, revision); failure == nil || failure.code != "unsafe_path" {
				t.Errorf("%s %q = %v, want unsafe_path", operation, path, failure)
			}
		}
	}
	paths, failure := walkNames(t, active, 4)
	if failure != nil || !reflect.DeepEqual(paths, []string{"notes/plain.md"}) {
		t.Fatalf("walk = %v, %v; want only notes/plain.md", paths, failure)
	}
	if _, failure := walkNames(t, active, 3); failure == nil || failure.code != "entry_limit" {
		t.Fatalf("walk with 3 entries = %v, want entry_limit: left-out files still count", failure)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "outside sentinel" {
		t.Fatalf("outside file changed: %q, %v", data, err)
	}
	entries, err := os.ReadDir(notes)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !slices.Equal(names, []string{"first.md", "linked.md", "plain.md", "second.md"}) {
		t.Fatalf("notes entries = %v", names)
	}
}
