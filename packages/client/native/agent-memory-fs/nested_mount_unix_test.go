//go:build !windows

package main

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
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
		for _, operation := range []string{"read", "observe", "replace", "delete", "append", "walk", "cleanup"} {
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

func startRecord(t *testing.T, active *session) []walkEntry {
	t.Helper()
	result, failure := active.walk(walkRequest{ID: "walk", Protocol: protocolVersion, Op: "walk", Path: "notes", MaxEntries: maxWalkEntries})
	if failure != nil {
		t.Fatalf("walk: %#v", failure)
	}
	return result.Entries
}

func cleanupHome(active *session, entries []walkEntry, files ...string) (int, *protocolError) {
	result, failure := active.cleanup(cleanupRequest{ID: "cleanup", Protocol: protocolVersion, Op: "cleanup", Files: append([]string{"MEMORY.md"}, files...), Entries: entries})
	return result.Deleted, failure
}

func requireAbsent(t *testing.T, paths ...string) {
	t.Helper()
	for _, path := range paths {
		if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s must be gone: %v", path, err)
		}
	}
}

func requirePresent(t *testing.T, paths ...string) {
	t.Helper()
	for _, path := range paths {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("%s must stay: %v", path, err)
		}
	}
}

func TestWalkRecordsEverythingItSeesAndListsTheSameFiles(t *testing.T) {
	home := newMemoryHome(t)
	notes := filepath.Join(home, "notes")
	if err := os.Mkdir(filepath.Join(notes, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeHomeFile(t, filepath.Join(notes, "sub", "a.md"), "listed")
	writeHomeFile(t, filepath.Join(notes, "linked.md"), "two links")
	if err := os.Link(filepath.Join(notes, "linked.md"), filepath.Join(t.TempDir(), "other")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(notes, "con"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeHomeFile(t, filepath.Join(notes, "con", "not-seen.md"), "the walk does not enter it")
	writeHomeFile(t, filepath.Join(notes, "con.md"), "a name the walk leaves out")
	if err := syscall.Mkfifo(filepath.Join(notes, "nul.md"), 0o600); err != nil {
		t.Fatal(err)
	}
	active := openNamesSession(t, home)
	result, failure := active.walk(walkRequest{ID: "walk", Protocol: protocolVersion, Op: "walk", Path: "notes", MaxEntries: maxWalkEntries})
	if failure != nil {
		t.Fatalf("walk: %#v", failure)
	}
	if !reflect.DeepEqual(result.Paths, []string{"notes/sub/a.md"}) {
		t.Fatalf("paths = %v", result.Paths)
	}
	slices.SortFunc(result.Entries, func(a, b walkEntry) int { return strings.Compare(a.Path, b.Path) })
	if want := []walkEntry{
		{"notes/con", kindOpaqueDirectory}, {"notes/con.md", kindFile}, {"notes/linked.md", kindFile}, {"notes/nul.md", kindOther}, {"notes/sub", kindDirectory}, {"notes/sub/a.md", kindFile},
	}; !reflect.DeepEqual(result.Entries, want) {
		t.Fatalf("entries = %v, want %v", result.Entries, want)
	}
}

func TestCleanupDeletesWhatIsNotInTheRecordAndNothingElse(t *testing.T) {
	home := newMemoryHome(t)
	notes := filepath.Join(home, "notes")
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel.md")
	writeHomeFile(t, sentinel, "outside sentinel")
	for _, directory := range []string{"sub", "many", "retyped-directory", "con"} {
		if err := os.Mkdir(filepath.Join(notes, directory), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for path, content := range map[string]string{
		"kept.md":        "kept",
		"sub/kept.md":    "kept below",
		"old.json":       "older than the Attempt",
		"retyped.md":     "a file at the start",
		"gained-link.md": "one link at the start",
		"con/opaque.md":  "the walk does not enter it",
		"case.md":        "kept",
	} {
		writeHomeFile(t, filepath.Join(notes, path), content)
	}
	if err := os.Link(sentinel, filepath.Join(notes, "linked.md")); err != nil {
		t.Fatal(err)
	}
	active := openNamesSession(t, home)
	entries := startRecord(t, active)

	for path, content := range map[string]string{"new.md": "new", "not-utf8.md": "\xff\xfe", "data.json": "new", "con/also-opaque.md": "stays with its directory"} {
		writeHomeFile(t, filepath.Join(notes, path), content)
	}
	if err := os.WriteFile(filepath.Join(notes, "big.md"), bytes.Repeat([]byte("x"), maxLocalLogBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(notes, "tree", "below"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeHomeFile(t, filepath.Join(notes, "tree", "below", "a.txt"), "goes with its directory")
	for index := range maxWalkEntries + 1 {
		writeHomeFile(t, filepath.Join(notes, "many", "n"+strconv.Itoa(index)+".md"), "new")
	}
	for link, target := range map[string]string{"link.md": sentinel, "sub/link": outside} {
		if err := os.Symlink(target, filepath.Join(notes, link)); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Mkfifo(filepath.Join(notes, "pipe.md"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(notes, "gained-link.md"), filepath.Join(outside, "second-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(notes, "retyped.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(notes, "retyped.md"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(notes, "retyped-directory")); err != nil {
		t.Fatal(err)
	}
	writeHomeFile(t, filepath.Join(notes, "retyped-directory"), "a directory at the start")
	want := 11 + maxWalkEntries + 1
	if _, err := os.Lstat(filepath.Join(notes, "CASE.md")); err != nil {
		writeHomeFile(t, filepath.Join(notes, "CASE.md"), "a case variant the Attempt added")
		want++
	}

	deleted, failure := cleanupHome(active, entries, "notes/kept.md", "notes/sub/kept.md", "notes/gained-link.md", "notes/case.md")
	if failure != nil {
		t.Fatalf("cleanup: %#v", failure)
	}
	if deleted != want {
		t.Fatalf("deleted = %d, want %d", deleted, want)
	}
	requireAbsent(t, filepath.Join(notes, "new.md"), filepath.Join(notes, "not-utf8.md"), filepath.Join(notes, "data.json"), filepath.Join(notes, "big.md"), filepath.Join(notes, "tree"),
		filepath.Join(notes, "link.md"), filepath.Join(notes, "sub", "link"), filepath.Join(notes, "pipe.md"), filepath.Join(notes, "gained-link.md"),
		filepath.Join(notes, "retyped.md"), filepath.Join(notes, "retyped-directory"))
	requireEntries(t, filepath.Join(notes, "many"))
	assertSentinel(t, sentinel, "outside sentinel")
	assertSentinel(t, filepath.Join(outside, "second-link"), "one link at the start")
	assertSentinel(t, filepath.Join(notes, "kept.md"), "kept")
	assertSentinel(t, filepath.Join(notes, "sub", "kept.md"), "kept below")
	assertSentinel(t, filepath.Join(notes, "old.json"), "older than the Attempt")
	requirePresent(t, filepath.Join(home, "MEMORY.md"), filepath.Join(notes, "linked.md"), filepath.Join(notes, "con", "opaque.md"), filepath.Join(notes, "con", "also-opaque.md"))
}

// A case pair stops being a pair when one name goes. What the walk did at the
// start decides, so the survivor's contents, which it never saw, stay.
func TestCleanupLeavesADirectoryTheWalkDidNotEnterAfterItsPairGoes(t *testing.T) {
	home := newMemoryHome(t)
	notes := filepath.Join(home, "notes")
	if err := os.Mkdir(filepath.Join(notes, "pair"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(notes, "PAIR")); err == nil {
		t.Skip("the volume folds letter case")
	}
	if err := os.Mkdir(filepath.Join(notes, "PAIR"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeHomeFile(t, filepath.Join(notes, "pair", "held.md"), "the walk did not list it")
	active := openNamesSession(t, home)
	entries := startRecord(t, active)
	if err := os.Remove(filepath.Join(notes, "PAIR")); err != nil {
		t.Fatal(err)
	}
	if deleted, failure := cleanupHome(active, entries); failure != nil || deleted != 0 {
		t.Fatalf("cleanup = %d, %#v", deleted, failure)
	}
	assertSentinel(t, filepath.Join(notes, "pair", "held.md"), "the walk did not list it")
}

func TestCleanupClearsAResidentFileOrNotesOfTheWrongType(t *testing.T) {
	home := newMemoryHome(t)
	outside := filepath.Join(t.TempDir(), "sentinel.md")
	writeHomeFile(t, outside, "outside sentinel")
	memory, notes := filepath.Join(home, "MEMORY.md"), filepath.Join(home, "notes")
	if err := os.Remove(memory); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, memory); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(notes); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), notes); err != nil {
		t.Fatal(err)
	}
	active := openNamesSession(t, home)
	if deleted, failure := cleanupHome(active, nil); failure != nil || deleted != 2 {
		t.Fatalf("cleanup = %d, %#v", deleted, failure)
	}
	requireAbsent(t, memory, notes)
	assertSentinel(t, outside, "outside sentinel")

	if err := os.Mkdir(memory, 0o700); err != nil {
		t.Fatal(err)
	}
	writeHomeFile(t, filepath.Join(memory, "stray.txt"), "goes with its directory")
	writeHomeFile(t, notes, "a file where the directory goes")
	if deleted, failure := cleanupHome(active, nil); failure != nil || deleted != 2 {
		t.Fatalf("cleanup = %d, %#v", deleted, failure)
	}
	requireAbsent(t, memory, notes)
	if deleted, failure := cleanupHome(active, nil); failure != nil || deleted != 0 {
		t.Fatalf("a second cleanup = %d, %#v", deleted, failure)
	}
}

func TestCleanupTakesOnlyExactNamesInTheHomeRoot(t *testing.T) {
	home := newMemoryHome(t)
	notes, memory := filepath.Join(home, "Notes"), filepath.Join(home, "memory.md")
	if _, err := os.Lstat(notes); err == nil {
		t.Skip("the volume folds letter case, so the root has one entry for each name")
	}
	if err := os.Mkdir(notes, 0o700); err != nil {
		t.Fatal(err)
	}
	writeHomeFile(t, filepath.Join(notes, "older.md"), "older than the Attempt")
	writeHomeFile(t, memory, "older than the Attempt")
	if deleted, failure := cleanupHome(openNamesSession(t, home), nil); failure != nil || deleted != 0 {
		t.Fatalf("cleanup = %d, %#v", deleted, failure)
	}
	requirePresent(t, filepath.Join(notes, "older.md"), memory)
}

func TestCleanupRefusesAnInvalidRecord(t *testing.T) {
	home := newMemoryHome(t)
	writeHomeFile(t, filepath.Join(home, "notes", "new.md"), "new")
	active := openNamesSession(t, home)
	for _, request := range []cleanupRequest{
		{Files: []string{"notes/kept.md"}, Entries: []walkEntry{{"notes/kept.md", kindFile}}},
		{Files: []string{"MEMORY.md", "MEMORY.md"}},
		{Files: []string{"MEMORY.md", "notes/kept.md"}},
		{Files: []string{"MEMORY.md", "notes/kept.md"}, Entries: []walkEntry{{"notes/kept.md", kindDirectory}}},
		{Files: []string{"MEMORY.md"}, Entries: []walkEntry{{"other/kept.md", kindFile}}},
		{Files: []string{"MEMORY.md"}, Entries: []walkEntry{{"notes/kept.md", "symlink"}}},
		{Files: []string{"MEMORY.md"}, Entries: []walkEntry{{"notes/kept.md", kindFile}, {"notes/kept.md", kindFile}}},
	} {
		request.ID, request.Protocol, request.Op = "cleanup", protocolVersion, "cleanup"
		if _, failure := active.cleanup(request); failure == nil || failure.code != "invalid_request" {
			t.Fatalf("record %v: %#v", request, failure)
		}
	}
	requirePresent(t, filepath.Join(home, "notes", "new.md"))
}

// A file on a nested volume must survive the removal of a directory around it.
func TestCleanupDoesNotDescendIntoAnotherVolume(t *testing.T) {
	home := newMemoryHome(t)
	tree := filepath.Join(home, "notes", "tree")
	if err := os.MkdirAll(filepath.Join(tree, "mounted"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeHomeFile(t, filepath.Join(tree, "mounted", "other-volume.txt"), "on another volume")
	active := openNamesSession(t, home)
	original := sameEntryVolume
	t.Cleanup(func() { sameEntryVolume = original })
	sameEntryVolume = func(parent, entry fs.FileInfo) (bool, error) {
		if entry.Name() == "mounted" {
			return false, nil
		}
		return sameVolume(parent, entry)
	}
	if _, failure := cleanupHome(active, nil); failure == nil || failure.code != "unsafe_path" {
		t.Fatalf("cleanup across a volume: %#v", failure)
	}
	assertSentinel(t, filepath.Join(tree, "mounted", "other-volume.txt"), "on another volume")
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
