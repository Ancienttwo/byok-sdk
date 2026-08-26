// agent-memory-fs is a task-scoped, private stdio filesystem helper.
//
// It intentionally accepts its root and all untrusted content only through
// JSON-lines stdin. Nothing security-sensitive is accepted through argv,
// environment variables, or PATH discovery.
package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	protocolVersion = 2
	helperVersion   = "2"

	maxFileBytes      = 256 * 1024
	maxLocalLogBytes  = 1 * 1024 * 1024
	maxWalkEntries    = 512
	maxPathBytes      = 1024
	maxRequestIDBytes = 128
	// Replace content crosses the protocol as raw base64, so one complete
	// maxLocalLogBytes internal-state request and response remain bounded below
	// two MiB without accepting an unbounded JSON expansion of control bytes.
	maxRequestJSONLineBytes  = 2 * 1024 * 1024
	maxResponseJSONLineBytes = 2 * 1024 * 1024
)

type rootIdentity struct {
	Kind         string `json:"kind"`
	Dev          string `json:"dev,omitempty"`
	Ino          string `json:"ino,omitempty"`
	VolumeSerial string `json:"volumeSerial,omitempty"`
	FileIndex    string `json:"fileIndex,omitempty"`
}

type baseRequest struct {
	ID       string `json:"id"`
	Protocol int    `json:"protocol"`
	Op       string `json:"op"`
}

type openRequest struct {
	ID               string       `json:"id"`
	Protocol         int          `json:"protocol"`
	Op               string       `json:"op"`
	Root             string       `json:"root"`
	ExpectedIdentity rootIdentity `json:"expectedIdentity"`
}

type readRequest struct {
	ID       string `json:"id"`
	Protocol int    `json:"protocol"`
	Op       string `json:"op"`
	Path     string `json:"path"`
	MaxBytes int    `json:"maxBytes"`
}

type replaceRequest struct {
	ID               string `json:"id"`
	Protocol         int    `json:"protocol"`
	Op               string `json:"op"`
	Path             string `json:"path"`
	ExpectedRevision string `json:"expectedRevision"`
	ContentBase64    string `json:"contentBase64"`
	MaxBytes         int    `json:"maxBytes"`
}

type deleteRequest struct {
	ID               string `json:"id"`
	Protocol         int    `json:"protocol"`
	Op               string `json:"op"`
	Path             string `json:"path"`
	ExpectedRevision string `json:"expectedRevision"`
}

type appendRequest struct {
	ID       string `json:"id"`
	Protocol int    `json:"protocol"`
	Op       string `json:"op"`
	Path     string `json:"path"`
	Content  string `json:"content"`
	MaxBytes int    `json:"maxBytes"`
}

type walkRequest struct {
	ID         string `json:"id"`
	Protocol   int    `json:"protocol"`
	Op         string `json:"op"`
	Path       string `json:"path"`
	MaxEntries int    `json:"maxEntries"`
}

type closeRequest struct {
	ID       string `json:"id"`
	Protocol int    `json:"protocol"`
	Op       string `json:"op"`
}

type request struct {
	id      string
	op      string
	open    *openRequest
	read    *readRequest
	replace *replaceRequest
	delete  *deleteRequest
	append  *appendRequest
	walk    *walkRequest
	close   *closeRequest
}

type responseError struct {
	Code           string `json:"code"`
	Message        string `json:"message"`
	ActualRevision string `json:"actualRevision,omitempty"`
}

type response struct {
	ID       string         `json:"id"`
	OK       bool           `json:"ok"`
	Protocol int            `json:"protocol"`
	Result   any            `json:"result,omitempty"`
	Error    *responseError `json:"error,omitempty"`
}

type protocolError struct {
	code           string
	message        string
	actualRevision string
}

func (e *protocolError) Error() string { return e.code }

func failure(code, message string) *protocolError {
	return &protocolError{code: code, message: message}
}

func revisionConflict(actual string) *protocolError {
	return &protocolError{
		code:           "revision_conflict",
		message:        "revision does not match",
		actualRevision: actual,
	}
}

type fileState struct {
	Exists        bool   `json:"exists"`
	ContentBase64 string `json:"contentBase64"`
	Revision      string `json:"revision"`
	ByteCount     int    `json:"byteCount"`
}

type openResult struct {
	Identity      rootIdentity `json:"identity"`
	HelperVersion string       `json:"helperVersion"`
}

type walkResult struct {
	Paths []string `json:"paths"`
}

type session struct {
	root     *os.Root
	identity rootIdentity
}

type pinnedDirectory struct {
	root    *os.Root
	closers []*os.Root
}

func main() {
	if err := runCLI(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		// Do not print Go/OS error strings: they can contain the absolute root or
		// a requested pathname. Protocol callers receive a bounded typed failure.
		fmt.Fprintln(os.Stderr, "agent-memory-fs failed")
		os.Exit(1)
	}
}

func runCLI(args []string, input io.Reader, output io.Writer) error {
	if len(args) == 1 && args[0] == "--version" {
		_, err := fmt.Fprintln(output, helperVersion)
		return err
	}
	if len(args) != 1 || args[0] != "serve" {
		return errors.New("invalid command")
	}
	return serve(input, output)
}

func serve(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), maxRequestJSONLineBytes)

	var active *session
	for scanner.Scan() {
		line := scanner.Bytes()
		req, decodeErr := decodeRequest(line)
		if decodeErr != nil {
			if err := writeFailure(output, requestID(line), decodeErr); err != nil {
				return err
			}
			continue
		}

		if active == nil {
			if req.op != "open" || req.open == nil {
				if err := writeFailure(output, req.id, failure("protocol_sequence", "first request must open a root")); err != nil {
					return err
				}
				continue
			}
			opened, openErr := openSession(*req.open)
			if openErr != nil {
				if err := writeFailure(output, req.id, openErr); err != nil {
					return err
				}
				continue
			}
			active = opened
			if err := writeSuccess(output, req.id, openResult{Identity: active.identity, HelperVersion: helperVersion}); err != nil {
				_ = active.root.Close()
				return err
			}
			continue
		}

		if req.op == "open" {
			if err := writeFailure(output, req.id, failure("protocol_sequence", "root is already open")); err != nil {
				_ = active.root.Close()
				return err
			}
			continue
		}
		if req.op == "close" {
			if err := active.root.Close(); err != nil {
				_ = writeFailure(output, req.id, failure("io_failure", "filesystem operation failed"))
				return err
			}
			return writeSuccess(output, req.id, map[string]bool{"closed": true})
		}

		result, operationErr := active.handle(req)
		if operationErr != nil {
			if err := writeFailure(output, req.id, operationErr); err != nil {
				_ = active.root.Close()
				return err
			}
			continue
		}
		if err := writeSuccess(output, req.id, result); err != nil {
			_ = active.root.Close()
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if active != nil {
		_ = active.root.Close()
		return errors.New("stdin ended before close")
	}
	return errors.New("stdin ended before open")
}

func (s *session) handle(req request) (any, *protocolError) {
	if current, err := s.currentIdentity(); err != nil || current != s.identity {
		return nil, failure("root_identity_mismatch", "root identity no longer matches")
	}
	switch req.op {
	case "read":
		return s.read(*req.read)
	case "replace":
		return s.replace(*req.replace)
	case "delete":
		return s.delete(*req.delete)
	case "append":
		return s.append(*req.append)
	case "walk":
		return s.walk(*req.walk)
	default:
		return nil, failure("invalid_request", "request is invalid")
	}
}

func (s *session) currentIdentity() (rootIdentity, error) {
	info, err := s.root.Stat(".")
	if err != nil || !info.IsDir() {
		return rootIdentity{}, errors.New("root unavailable")
	}
	return identityForRoot(s.root, info)
}

func openSession(req openRequest) (*session, *protocolError) {
	if runtime.GOOS == "windows" {
		// Cross-builds prove the handle identity implementation compiles, but a
		// Windows reparse/junction race matrix is required before this authority
		// may be admitted. Never report a successful open before that proof.
		return nil, failure("unsupported_platform", "secure filesystem is not admitted on this platform")
	}
	if !validRequestID(req.ID) || req.Protocol != protocolVersion || req.Op != "open" || !validRootIdentity(req.ExpectedIdentity) {
		return nil, failure("invalid_request", "request is invalid")
	}
	if len(req.Root) == 0 || len(req.Root) > 4096 || strings.IndexByte(req.Root, 0) >= 0 || !filepath.IsAbs(req.Root) {
		return nil, failure("invalid_root", "root is invalid")
	}

	before, err := os.Lstat(req.Root)
	if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, failure("unsafe_root", "root is unavailable or unsafe")
	}
	root, err := os.OpenRoot(req.Root)
	if err != nil {
		return nil, failure("unsafe_root", "root is unavailable or unsafe")
	}
	closeRoot := true
	defer func() {
		if closeRoot {
			_ = root.Close()
		}
	}()

	after, err := root.Stat(".")
	if err != nil || !after.IsDir() || !os.SameFile(before, after) {
		return nil, failure("unsafe_root", "root is unavailable or unsafe")
	}
	post, err := os.Lstat(req.Root)
	if err != nil || !post.IsDir() || post.Mode()&os.ModeSymlink != 0 || !os.SameFile(before, post) {
		return nil, failure("unsafe_root", "root is unavailable or unsafe")
	}
	actual, err := identityForRoot(root, after)
	if err != nil {
		return nil, failure("unsafe_root", "root is unavailable or unsafe")
	}
	if actual != req.ExpectedIdentity {
		return nil, failure("root_identity_mismatch", "root identity does not match")
	}
	closeRoot = false
	return &session{root: root, identity: actual}, nil
}

func (s *session) read(req readRequest) (fileState, *protocolError) {
	if err := validatePathAndLimit(req.ID, req.Protocol, req.Op, req.Path, req.MaxBytes); err != nil {
		return fileState{}, err
	}
	parent, leaf, err := s.openParent(req.Path)
	if err != nil {
		return fileState{}, err
	}
	defer parent.Close()
	return parent.readState(leaf, req.MaxBytes)
}

func (s *session) replace(req replaceRequest) (fileState, *protocolError) {
	if err := validatePathAndLimit(req.ID, req.Protocol, req.Op, req.Path, req.MaxBytes); err != nil {
		return fileState{}, err
	}
	content, decodeErr := base64.RawStdEncoding.Strict().DecodeString(req.ContentBase64)
	if decodeErr != nil || !utf8.Valid(content) || !validRevision(req.ExpectedRevision) || len(content) > req.MaxBytes {
		return fileState{}, failure("invalid_request", "request is invalid")
	}
	parent, leaf, err := s.openParent(req.Path)
	if err != nil {
		return fileState{}, err
	}
	defer parent.Close()

	before, err := parent.readState(leaf, req.MaxBytes)
	if err != nil {
		return fileState{}, err
	}
	if before.Revision != req.ExpectedRevision {
		return fileState{}, revisionConflict(before.Revision)
	}

	temporary, temp, err := parent.createExclusiveTemp("replace")
	if err != nil {
		return fileState{}, err
	}
	removeTemp := true
	defer func() {
		if removeTemp {
			if temp != nil {
				_ = temp.Close()
			}
			_ = parent.root.Remove(temporary)
		}
	}()
	if _, writeErr := temp.Write(content); writeErr != nil {
		return fileState{}, failure("io_failure", "filesystem operation failed")
	}
	if syncErr := temp.Sync(); syncErr != nil || temp.Close() != nil {
		return fileState{}, failure("io_failure", "filesystem operation failed")
	}
	temp = nil

	final, err := parent.readState(leaf, req.MaxBytes)
	if err != nil {
		return fileState{}, err
	}
	if final.Revision != req.ExpectedRevision {
		return fileState{}, revisionConflict(final.Revision)
	}
	if err := parent.root.Rename(temporary, leaf); err != nil {
		return fileState{}, failure("io_failure", "filesystem operation failed")
	}
	removeTemp = false
	if err := parent.sync(); err != nil {
		return fileState{}, failure("io_failure", "filesystem operation failed")
	}
	return parent.readState(leaf, req.MaxBytes)
}

func (s *session) delete(req deleteRequest) (map[string]bool, *protocolError) {
	if !validRequestID(req.ID) || req.Protocol != protocolVersion || req.Op != "delete" || !validRelativePath(req.Path) || !validRevision(req.ExpectedRevision) {
		return nil, failure("invalid_request", "request is invalid")
	}
	parent, leaf, err := s.openParent(req.Path)
	if err != nil {
		return nil, err
	}
	defer parent.Close()

	before, err := parent.readState(leaf, maxFileBytes)
	if err != nil {
		return nil, err
	}
	if !before.Exists || before.Revision != req.ExpectedRevision {
		return nil, revisionConflict(before.Revision)
	}
	final, err := parent.readState(leaf, maxFileBytes)
	if err != nil {
		return nil, err
	}
	if !final.Exists || final.Revision != req.ExpectedRevision {
		return nil, revisionConflict(final.Revision)
	}

	tombstone := temporaryName("delete")
	if err := parent.root.Rename(leaf, tombstone); err != nil {
		return nil, failure("io_failure", "filesystem operation failed")
	}
	if err := parent.sync(); err != nil {
		return nil, failure("io_failure", "filesystem operation failed")
	}
	if err := parent.root.Remove(tombstone); err != nil {
		return nil, failure("io_failure", "filesystem operation failed")
	}
	if err := parent.sync(); err != nil {
		return nil, failure("io_failure", "filesystem operation failed")
	}
	return map[string]bool{"deleted": true}, nil
}

func (s *session) append(req appendRequest) (fileState, *protocolError) {
	if err := validatePathAndLimit(req.ID, req.Protocol, req.Op, req.Path, req.MaxBytes); err != nil {
		return fileState{}, err
	}
	content := []byte(req.Content)
	if len(content) > req.MaxBytes || len(content) > maxFileBytes {
		return fileState{}, failure("size_limit", "file exceeds the requested byte limit")
	}
	parent, leaf, err := s.openParent(req.Path)
	if err != nil {
		return fileState{}, err
	}
	defer parent.Close()

	file, info, exists, err := parent.openExisting(leaf, os.O_RDWR|os.O_APPEND)
	if err != nil {
		return fileState{}, err
	}
	created := false
	if !exists {
		newFile, openErr := parent.root.OpenFile(leaf, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if openErr != nil {
			return fileState{}, failure("io_failure", "filesystem operation failed")
		}
		file = newFile
		info, statErr := file.Stat()
		post, lstatErr := parent.root.Lstat(leaf)
		if statErr != nil || lstatErr != nil || !info.Mode().IsRegular() || post.Mode()&os.ModeSymlink != 0 || !post.Mode().IsRegular() || !os.SameFile(info, post) {
			_ = newFile.Close()
			return fileState{}, failure("unsafe_path", "path is unsafe")
		}
		created = true
	} else if info.Size()+int64(len(content)) > int64(req.MaxBytes) {
		_ = file.Close()
		return fileState{}, failure("size_limit", "file exceeds the requested byte limit")
	}
	_, writeErr := file.Write(content)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return fileState{}, failure("io_failure", "filesystem operation failed")
	}
	if created && parent.sync() != nil {
		return fileState{}, failure("io_failure", "filesystem operation failed")
	}
	state, stateErr := parent.readState(leaf, req.MaxBytes)
	if stateErr != nil {
		return fileState{}, stateErr
	}
	// Append callers only require durable completion. Returning the whole log
	// would turn a bounded append into a multi-megabyte response.
	state.ContentBase64 = ""
	return state, nil
}

func (s *session) walk(req walkRequest) (walkResult, *protocolError) {
	if !validRequestID(req.ID) || req.Protocol != protocolVersion || req.Op != "walk" || !validRelativePath(req.Path) || req.MaxEntries <= 0 || req.MaxEntries > maxWalkEntries {
		return walkResult{}, failure("invalid_request", "request is invalid")
	}
	parent, leaf, err := s.openParent(req.Path)
	if err != nil {
		return walkResult{}, err
	}
	defer parent.Close()
	directory, err := parent.openPinnedChild(leaf)
	if err != nil {
		return walkResult{}, err
	}
	defer directory.Close()

	entriesSeen := 0
	paths := make([]string, 0)
	if err := walkPinned(directory.root, req.Path, req.MaxEntries, &entriesSeen, &paths); err != nil {
		return walkResult{}, err
	}
	sort.Strings(paths)
	return walkResult{Paths: paths}, nil
}

func walkPinned(directory *os.Root, prefix string, maximum int, entriesSeen *int, paths *[]string) *protocolError {
	file, err := directory.Open(".")
	if err != nil {
		return failure("io_failure", "filesystem operation failed")
	}
	entries, readErr := file.ReadDir(-1)
	_ = file.Close()
	if readErr != nil {
		return failure("io_failure", "filesystem operation failed")
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		name := entry.Name()
		if !validSegment(name) {
			return failure("unsafe_path", "path is unsafe")
		}
		*entriesSeen++
		if *entriesSeen > maximum {
			return failure("entry_limit", "walk exceeds the requested entry limit")
		}
		info, err := directory.Lstat(name)
		if err != nil {
			return failure("io_failure", "filesystem operation failed")
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return failure("unsafe_path", "path is unsafe")
		}
		if info.IsDir() {
			child, childErr := openVerifiedChild(directory, name)
			if childErr != nil {
				return childErr
			}
			walkErr := walkPinned(child, prefix+"/"+name, maximum, entriesSeen, paths)
			_ = child.Close()
			if walkErr != nil {
				return walkErr
			}
			continue
		}
		if !info.Mode().IsRegular() {
			return failure("unsafe_path", "path is unsafe")
		}
		// Pin each leaf before listing it, even though walk only returns names.
		leaf, after, exists, leafErr := (&pinnedDirectory{root: directory}).openExisting(name, os.O_RDONLY)
		if leafErr != nil || !exists || !os.SameFile(info, after) {
			if leaf != nil {
				_ = leaf.Close()
			}
			return failure("unsafe_path", "path is unsafe")
		}
		_ = leaf.Close()
		*paths = append(*paths, prefix+"/"+name)
	}
	return nil
}

func (s *session) openParent(relative string) (*pinnedDirectory, string, *protocolError) {
	parts := strings.Split(relative, "/")
	if len(parts) == 0 {
		return nil, "", failure("invalid_path", "path is invalid")
	}
	current := s.root
	closers := make([]*os.Root, 0, len(parts)-1)
	for _, part := range parts[:len(parts)-1] {
		child, err := openVerifiedChild(current, part)
		if err != nil {
			for index := len(closers) - 1; index >= 0; index-- {
				_ = closers[index].Close()
			}
			return nil, "", err
		}
		closers = append(closers, child)
		current = child
	}
	return &pinnedDirectory{root: current, closers: closers}, parts[len(parts)-1], nil
}

func (p *pinnedDirectory) openPinnedChild(name string) (*pinnedDirectory, *protocolError) {
	child, err := openVerifiedChild(p.root, name)
	if err != nil {
		return nil, err
	}
	// The caller keeps p open for the returned child's entire lifetime. Closing
	// only the child avoids closing the caller's directory chain twice.
	return &pinnedDirectory{root: child, closers: []*os.Root{child}}, nil
}

func openVerifiedChild(parent *os.Root, name string) (*os.Root, *protocolError) {
	before, err := parent.Lstat(name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, failure("not_found", "path does not exist")
		}
		return nil, failure("io_failure", "filesystem operation failed")
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.IsDir() {
		return nil, failure("unsafe_path", "path is unsafe")
	}
	child, err := parent.OpenRoot(name)
	if err != nil {
		return nil, failure("unsafe_path", "path is unsafe")
	}
	keepChild := false
	defer func() {
		if !keepChild {
			_ = child.Close()
		}
	}()
	after, err := child.Stat(".")
	if err != nil || !after.IsDir() || !os.SameFile(before, after) {
		return nil, failure("unsafe_path", "path is unsafe")
	}
	post, err := parent.Lstat(name)
	if err != nil || post.Mode()&os.ModeSymlink != 0 || !post.IsDir() || !os.SameFile(before, post) {
		return nil, failure("unsafe_path", "path is unsafe")
	}
	keepChild = true
	return child, nil
}

func (p *pinnedDirectory) readState(name string, maximum int) (fileState, *protocolError) {
	file, info, exists, err := p.openExisting(name, os.O_RDONLY)
	if err != nil {
		return fileState{}, err
	}
	if !exists {
		return emptyFileState(), nil
	}
	defer file.Close()
	return fileStateFromOpenFile(file, info, maximum)
}

func (p *pinnedDirectory) openExisting(name string, flags int) (*os.File, fs.FileInfo, bool, *protocolError) {
	before, err := p.root.Lstat(name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, false, nil
		}
		return nil, nil, false, failure("io_failure", "filesystem operation failed")
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return nil, nil, false, failure("unsafe_path", "path is unsafe")
	}
	file, err := p.root.OpenFile(name, flags, 0)
	if err != nil {
		return nil, nil, false, failure("unsafe_path", "path is unsafe")
	}
	keepFile := false
	defer func() {
		if !keepFile {
			_ = file.Close()
		}
	}()
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return nil, nil, false, failure("unsafe_path", "path is unsafe")
	}
	post, err := p.root.Lstat(name)
	if err != nil || post.Mode()&os.ModeSymlink != 0 || !post.Mode().IsRegular() || !os.SameFile(before, post) {
		return nil, nil, false, failure("unsafe_path", "path is unsafe")
	}
	keepFile = true
	return file, after, true, nil
}

func fileStateFromOpenFile(file *os.File, before fs.FileInfo, maximum int) (fileState, *protocolError) {
	if before.Size() < 0 || before.Size() > int64(maximum) || before.Size() > maxLocalLogBytes {
		return fileState{}, failure("size_limit", "file exceeds the requested byte limit")
	}
	data := make([]byte, int(before.Size()))
	if _, err := file.ReadAt(data, 0); err != nil && !(errors.Is(err, io.EOF) && len(data) == 0) {
		return fileState{}, failure("io_failure", "filesystem operation failed")
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return fileState{}, failure("file_changed", "file changed while it was read")
	}
	if !utf8.Valid(data) {
		return fileState{}, failure("invalid_content", "file is not valid UTF-8")
	}
	return stateForBytes(data), nil
}

func (p *pinnedDirectory) createExclusiveTemp(kind string) (string, *os.File, *protocolError) {
	for range 8 {
		name := temporaryName(kind)
		file, err := p.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", nil, failure("io_failure", "filesystem operation failed")
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			_ = p.root.Remove(name)
			return "", nil, failure("io_failure", "filesystem operation failed")
		}
		return name, file, nil
	}
	return "", nil, failure("io_failure", "filesystem operation failed")
}

func (p *pinnedDirectory) sync() error {
	file, err := p.root.Open(".")
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func (p *pinnedDirectory) Close() {
	for index := len(p.closers) - 1; index >= 0; index-- {
		_ = p.closers[index].Close()
	}
}

func emptyFileState() fileState { return stateForBytes(nil) }

func stateForBytes(data []byte) fileState {
	sum := sha256.Sum256(data)
	return fileState{
		Exists:        len(data) != 0 || data != nil,
		ContentBase64: base64.RawStdEncoding.EncodeToString(data),
		Revision:      "sha256:" + hex.EncodeToString(sum[:]),
		ByteCount:     len(data),
	}
}

func temporaryName(kind string) string {
	var randomBytes [16]byte
	if _, err := rand.Read(randomBytes[:]); err != nil {
		panic("system random source failed")
	}
	return ".byok-agent-memory-" + kind + "-" + hex.EncodeToString(randomBytes[:]) + ".tmp"
}

func validatePathAndLimit(id string, protocol int, op string, relative string, limit int) *protocolError {
	if !validRequestID(id) || protocol != protocolVersion || !validRelativePath(relative) || limit < 0 || limit > maxLocalLogBytes {
		return failure("invalid_request", "request is invalid")
	}
	return nil
}

func validRelativePath(value string) bool {
	if len(value) == 0 || len(value) > maxPathBytes || strings.IndexByte(value, 0) >= 0 || strings.Contains(value, "\\") || pathpkg.IsAbs(value) {
		return false
	}
	if pathpkg.Clean(value) != value {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if !validSegment(part) {
			return false
		}
	}
	return true
}

func validSegment(value string) bool {
	return value != "" && value != "." && value != ".." && strings.IndexByte(value, 0) < 0 && !strings.Contains(value, "/") && !strings.Contains(value, "\\")
}

func validRequestID(value string) bool {
	return len(value) > 0 && len(value) <= maxRequestIDBytes && strings.IndexByte(value, 0) < 0
}

func validRootIdentity(identity rootIdentity) bool {
	switch identity.Kind {
	case "unix":
		return validDecimal(identity.Dev) && validDecimal(identity.Ino) && identity.VolumeSerial == "" && identity.FileIndex == ""
	case "windows":
		return validDecimal(identity.VolumeSerial) && validDecimal(identity.FileIndex) && identity.Dev == "" && identity.Ino == ""
	default:
		return false
	}
}

func validDecimal(value string) bool {
	if len(value) == 0 || len(value) > 20 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func validRevision(value string) bool {
	if len(value) != len("sha256:")+sha256.Size*2 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	_, err := hex.DecodeString(value[len("sha256:"):])
	return err == nil
}

func decodeRequest(line []byte) (request, *protocolError) {
	var base baseRequest
	if err := json.Unmarshal(line, &base); err != nil || !validRequestID(base.ID) || base.Protocol != protocolVersion || base.Op == "" {
		return request{}, failure("malformed_request", "request is malformed")
	}
	requestValue := request{id: base.ID, op: base.Op}
	switch base.Op {
	case "open":
		var typed openRequest
		if err := strictJSON(line, &typed); err != nil || !hasRequiredJSONFields(line, "id", "protocol", "op", "root", "expectedIdentity") {
			return requestValue, failure("malformed_request", "request is malformed")
		}
		requestValue.open = &typed
	case "read":
		var typed readRequest
		if err := strictJSON(line, &typed); err != nil || !hasRequiredJSONFields(line, "id", "protocol", "op", "path", "maxBytes") {
			return requestValue, failure("malformed_request", "request is malformed")
		}
		requestValue.read = &typed
	case "replace":
		var typed replaceRequest
		if err := strictJSON(line, &typed); err != nil || !hasRequiredJSONFields(line, "id", "protocol", "op", "path", "expectedRevision", "contentBase64", "maxBytes") {
			return requestValue, failure("malformed_request", "request is malformed")
		}
		requestValue.replace = &typed
	case "delete":
		var typed deleteRequest
		if err := strictJSON(line, &typed); err != nil || !hasRequiredJSONFields(line, "id", "protocol", "op", "path", "expectedRevision") {
			return requestValue, failure("malformed_request", "request is malformed")
		}
		requestValue.delete = &typed
	case "append":
		var typed appendRequest
		if err := strictJSON(line, &typed); err != nil || !hasRequiredJSONFields(line, "id", "protocol", "op", "path", "content", "maxBytes") {
			return requestValue, failure("malformed_request", "request is malformed")
		}
		requestValue.append = &typed
	case "walk":
		var typed walkRequest
		if err := strictJSON(line, &typed); err != nil || !hasRequiredJSONFields(line, "id", "protocol", "op", "path", "maxEntries") {
			return requestValue, failure("malformed_request", "request is malformed")
		}
		requestValue.walk = &typed
	case "close":
		var typed closeRequest
		if err := strictJSON(line, &typed); err != nil || !hasRequiredJSONFields(line, "id", "protocol", "op") {
			return requestValue, failure("malformed_request", "request is malformed")
		}
		requestValue.close = &typed
	default:
		return requestValue, failure("invalid_request", "request is invalid")
	}
	return requestValue, nil
}

func strictJSON(line []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("extra JSON value")
	}
	return nil
}

func hasRequiredJSONFields(line []byte, names ...string) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(line, &fields); err != nil {
		return false
	}
	for _, name := range names {
		value, exists := fields[name]
		if !exists || len(value) == 0 || bytes.Equal(value, []byte("null")) {
			return false
		}
	}
	return true
}

func requestID(line []byte) string {
	var probe struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(line, &probe) == nil && validRequestID(probe.ID) {
		return probe.ID
	}
	return ""
}

func writeSuccess(output io.Writer, id string, result any) error {
	return writeResponse(output, response{ID: id, OK: true, Protocol: protocolVersion, Result: result})
}

func writeFailure(output io.Writer, id string, err *protocolError) error {
	return writeResponse(output, response{
		ID:       id,
		OK:       false,
		Protocol: protocolVersion,
		Error: &responseError{
			Code:           err.code,
			Message:        err.message,
			ActualRevision: err.actualRevision,
		},
	})
}

func writeResponse(output io.Writer, value response) error {
	line, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(line) > maxResponseJSONLineBytes {
		line, err = json.Marshal(response{
			ID:       value.ID,
			OK:       false,
			Protocol: protocolVersion,
			Error:    &responseError{Code: "response_too_large", Message: "response exceeds the protocol limit"},
		})
		if err != nil {
			return err
		}
	}
	line = append(line, '\n')
	_, err = output.Write(line)
	return err
}
