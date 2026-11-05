package main

import (
	"errors"
	"io/fs"
	"os"
	"runtime"
	"strings"
)

// Kinds of a walk record. An opaque directory is one the walk saw and did not
// enter, so its contents are not in the record and the cleanup leaves them.
const (
	kindFile            = "file"
	kindDirectory       = "directory"
	kindOpaqueDirectory = "opaque-directory"
	kindOther           = "other"
)

type cleanupRequest struct {
	ID       string      `json:"id"`
	Protocol int         `json:"protocol"`
	Op       string      `json:"op"`
	Files    []string    `json:"files"`
	Entries  []walkEntry `json:"entries"`
}

type cleanupResult struct {
	Deleted int `json:"deleted"`
}

// restoreRecord is the start record of an Attempt. Its paths are only compared
// with names read from the pinned directories; nothing opens them.
type restoreRecord struct {
	kinds map[string]string
	files map[string]bool
}

func parseRecord(req cleanupRequest) (*restoreRecord, bool) {
	record := &restoreRecord{kinds: make(map[string]string, len(req.Entries)), files: make(map[string]bool, len(req.Files))}
	for _, entry := range req.Entries {
		_, duplicate := record.kinds[entry.Path]
		if duplicate || !strings.HasPrefix(entry.Path, "notes/") {
			return nil, false
		}
		switch entry.Kind {
		case kindFile, kindDirectory, kindOpaqueDirectory, kindOther:
			record.kinds[entry.Path] = entry.Kind
		default:
			return nil, false
		}
	}
	for _, path := range req.Files {
		if record.files[path] || (path != "MEMORY.md" && record.kinds[path] != kindFile) {
			return nil, false
		}
		record.files[path] = true
	}
	return record, record.files["MEMORY.md"]
}

func singleLinkRegular(info fs.FileInfo) (bool, *protocolError) {
	if !info.Mode().IsRegular() {
		return false, nil
	}
	// The Lstat result carries the count on every platform this operation runs on.
	links, err := linkCount(nil, info)
	if err != nil {
		return false, failure("io_failure", "filesystem operation failed")
	}
	return links == 1, nil
}

// stays reports whether an entry has the path and the type it had at the start.
// A memory file must also still be a regular file with one link. The walk
// refuses a symlink, so no symlink is ever in the record.
func (r *restoreRecord) stays(path string, info fs.FileInfo) (bool, *protocolError) {
	switch r.kinds[path] {
	case kindDirectory, kindOpaqueDirectory:
		return info.IsDir(), nil
	case kindOther:
		return !info.Mode().IsRegular() && !info.IsDir() && info.Mode()&os.ModeSymlink == 0, nil
	case kindFile:
		if r.files[path] {
			return singleLinkRegular(info)
		}
		return info.Mode().IsRegular(), nil
	default:
		return false, nil
	}
}

// removeEntry deletes one entry without following a link. A directory goes
// level by level through verified roots, because os.Root.RemoveAll descends
// into a volume mounted below it and openVerifiedChild refuses one.
func removeEntry(directory *os.Root, name string, info fs.FileInfo) *protocolError {
	if err := requireParentVolume(directory, info); err != nil {
		return err
	}
	if info.IsDir() {
		child, err := openVerifiedChild(directory, name)
		if err != nil {
			return err
		}
		defer child.Close()
		names, err := directoryNames(child)
		if err != nil {
			return err
		}
		for _, entry := range names {
			entryInfo, lstatErr := child.Lstat(entry)
			if lstatErr != nil {
				return failure("io_failure", "filesystem operation failed")
			}
			if err := removeEntry(child, entry, entryInfo); err != nil {
				return err
			}
		}
	}
	if err := directory.Remove(name); err != nil {
		return failure("io_failure", "filesystem operation failed")
	}
	return nil
}

func syncDirectory(directory *os.Root) *protocolError {
	if err := (&pinnedDirectory{root: directory}).sync(); err != nil {
		return failure("io_failure", "filesystem operation failed")
	}
	return nil
}

func (r *restoreRecord) clean(directory *os.Root, prefix string, deleted *int) *protocolError {
	names, err := directoryNames(directory)
	if err != nil {
		return err
	}
	removed := 0
	for _, name := range names {
		path := prefix + "/" + name
		info, lstatErr := directory.Lstat(name)
		if lstatErr != nil {
			return failure("io_failure", "filesystem operation failed")
		}
		stays, staysErr := r.stays(path, info)
		if staysErr != nil {
			return staysErr
		}
		if !stays {
			if err := removeEntry(directory, name, info); err != nil {
				return err
			}
			removed++
			continue
		}
		if r.kinds[path] == kindDirectory {
			if err := r.descend(directory, name, path, deleted); err != nil {
				return err
			}
		}
	}
	*deleted += removed
	if removed > 0 {
		return syncDirectory(directory)
	}
	return nil
}

func (r *restoreRecord) descend(directory *os.Root, name, path string, deleted *int) *protocolError {
	child, err := openVerifiedChild(directory, name)
	if err != nil {
		return err
	}
	defer child.Close()
	return r.clean(child, path, deleted)
}

// cleanup is for the restore of a failed commit-on-success Attempt, under the
// exclusive writer lease with the runtime stopped. It compares paths and types
// with the start record and has no memory-path rule, no revision compare and no
// entry limit. The home root takes only the exact names MEMORY.md and notes:
// below notes the record decides, and no rule refuses a case variant in the
// root at the start.
func (s *session) cleanup(req cleanupRequest) (cleanupResult, *protocolError) {
	if !validRequestID(req.ID) || req.Protocol != protocolVersion || req.Op != "cleanup" {
		return cleanupResult{}, failure("invalid_request", "request is invalid")
	}
	record, valid := parseRecord(req)
	if !valid {
		return cleanupResult{}, failure("invalid_request", "request is invalid")
	}
	// Windows declares no commit on success, so nothing calls this there.
	if runtime.GOOS == "windows" {
		return cleanupResult{}, failure("unsupported", "operation is not supported on this platform")
	}
	deleted, removed := 0, 0
	for _, name := range []string{"MEMORY.md", "notes"} {
		info, err := s.root.Lstat(name)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return cleanupResult{}, failure("io_failure", "filesystem operation failed")
		}
		wanted := info.IsDir()
		if name == "MEMORY.md" {
			single, linkErr := singleLinkRegular(info)
			if linkErr != nil {
				return cleanupResult{}, linkErr
			}
			wanted = single
		}
		if !wanted {
			if err := removeEntry(s.root, name, info); err != nil {
				return cleanupResult{}, err
			}
			removed++
			continue
		}
		if name == "notes" {
			if err := record.descend(s.root, name, name, &deleted); err != nil {
				return cleanupResult{}, err
			}
		}
	}
	if removed > 0 {
		if err := syncDirectory(s.root); err != nil {
			return cleanupResult{}, err
		}
	}
	return cleanupResult{Deleted: deleted + removed}, nil
}
