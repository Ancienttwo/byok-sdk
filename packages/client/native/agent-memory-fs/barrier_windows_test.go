//go:build windows

package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"unsafe"
)

func TestWindowsRuntimeIdentityMatchesNativeHandle(t *testing.T) {
	runtimeBin := os.Getenv("BYOK_TEST_AGENT_MEMORY_JS_RUNTIME")
	if runtimeBin == "" {
		t.Skip("set BYOK_TEST_AGENT_MEMORY_JS_RUNTIME to require real Node/Bun identity parity")
	}
	if !filepath.IsAbs(runtimeBin) {
		t.Fatal("runtime path must be absolute")
	}
	home := t.TempDir()
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
	const script = `const s=require('node:fs').statSync(process.argv[1],{bigint:true});console.log(JSON.stringify({kind:'windows',volumeSerial:s.dev.toString(10),fileIndex:s.ino.toString(10)}));`
	command := exec.Command(runtimeBin, "-e", script, home)
	command.Env = []string{}
	output, err := command.Output()
	if err != nil {
		t.Fatalf("real runtime identity failed: %v", err)
	}
	var actual rootIdentity
	if err := json.Unmarshal(output, &actual); err != nil {
		t.Fatal(err)
	}
	if actual != identity {
		t.Fatalf("runtime=%#v native=%#v", actual, identity)
	}
}

// Diagnostic only: API failures are logged, not asserted as test failures.
// A passing test does not show that a flush API is available or successful.
// These calls prove neither containment nor model S recovery and do not grant B.
func TestWindowsDirectoryFlushDiagnosticsOnly(t *testing.T) {
	directory := t.TempDir()
	name, err := syscall.UTF16PtrFromString(directory)
	if err != nil {
		t.Fatal(err)
	}
	const access = syscall.GENERIC_READ | syscall.GENERIC_WRITE
	const share = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE
	const flags = syscall.FILE_FLAG_BACKUP_SEMANTICS | syscall.FILE_FLAG_OPEN_REPARSE_POINT
	handle, err := syscall.CreateFile(name, access, share, nil, syscall.OPEN_EXISTING, flags, 0)
	t.Logf("DIAGNOSTIC ONLY; NO ACCEPTANCE ASSERTION: access=%#x share=%#x open=%d flags=%#x CreateFileW=%v", uint32(access), share, syscall.OPEN_EXISTING, flags, err)
	if err != nil {
		return
	}
	defer syscall.CloseHandle(handle)
	t.Logf("DIAGNOSTIC ONLY; NO ACCEPTANCE ASSERTION: FlushFileBuffers=%v", syscall.FlushFileBuffers(handle))
	flush := syscall.NewLazyDLL("ntdll.dll").NewProc("NtFlushBuffersFileEx")
	if err := flush.Find(); err != nil {
		t.Logf("DIAGNOSTIC ONLY; NO ACCEPTANCE ASSERTION: NtFlushBuffersFileEx export=%v", err)
		return
	}
	// IO_STATUS_BLOCK has a pointer-sized union followed by ULONG_PTR.
	var ioStatus struct {
		Status      uintptr
		Information uintptr
	}
	status, _, _ := flush.Call(uintptr(handle), 0, 0, 0, uintptr(unsafe.Pointer(&ioStatus)))
	runtime.KeepAlive(&ioStatus)
	t.Logf("DIAGNOSTIC ONLY; NO ACCEPTANCE ASSERTION: NtFlushBuffersFileEx flags=0 NTSTATUS=%#x IO_STATUS=%#x Information=%d", uint32(status), ioStatus.Status, ioStatus.Information)
}

// Junction fixtures that exist before open. A junction home is refused. A
// junction ancestor is resolved, and the identity binds the real home. A
// junction inside the home fails every operation that reaches it. No operation
// may change the outside directory. No storage barrier is tested.
func TestWindowsOpenWithJunctionFixtures(t *testing.T) {
	for _, placement := range []string{"ordinary", "root-junction", "ancestor-junction", "notes-junction", "state-junction"} {
		t.Run(placement, func(t *testing.T) {
			outside := t.TempDir()
			writeFixture(t, filepath.Join(outside, "sentinel.md"), "outside")
			parent := t.TempDir()
			home := filepath.Join(parent, "home")
			if err := os.Mkdir(home, 0o700); err != nil {
				t.Fatal(err)
			}
			root, expected, reached := home, identityForTest(t, home), ""
			switch placement {
			case "root-junction":
				// A followed junction would match its target's identity.
				root, expected = filepath.Join(parent, "linked-home"), identityForTest(t, outside)
				makeReparsePoint(t, "junction", root, outside)
			case "ancestor-junction":
				linked := filepath.Join(t.TempDir(), "linked-parent")
				makeReparsePoint(t, "junction", linked, parent)
				root = filepath.Join(linked, "home")
			case "notes-junction":
				makeReparsePoint(t, "junction", filepath.Join(home, "notes"), outside)
				reached = "notes"
			case "state-junction":
				makeReparsePoint(t, "junction", filepath.Join(home, ".byok"), outside)
				reached = ".byok"
			}
			active, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: root, ExpectedIdentity: expected})
			if placement == "root-junction" {
				if active != nil || failure == nil || failure.code != "unsafe_root" {
					t.Fatalf("junction home admitted: session=%v error=%v", active, failure)
				}
				requireOutsideUnchanged(t, outside, "sentinel.md", "outside")
				return
			}
			if failure != nil {
				t.Fatalf("open: %#v", failure)
			}
			defer active.root.Close()
			if reached == "" {
				if _, failure := active.replace(replaceRequest{ID: "replace", Protocol: protocolVersion, Op: "replace", Path: "MEMORY.md",
					ExpectedRevision: emptyFileState().Revision, ContentBase64: base64.RawStdEncoding.EncodeToString([]byte("inside")), MaxBytes: maxFileBytes}); failure != nil {
					t.Fatalf("replace: %#v", failure)
				}
				if data, err := os.ReadFile(filepath.Join(home, "MEMORY.md")); err != nil || string(data) != "inside" {
					t.Fatalf("write did not land in the home: %q, %v", data, err)
				}
			} else {
				for _, operation := range []string{"read", "replace", "delete", "append", "walk"} {
					target := reached + "/sentinel.md"
					if operation == "walk" {
						target = reached
					}
					if failure := pinnedOperation(active, operation, target, stateForBytes([]byte("outside")).Revision); failure == nil || failure.code != "unsafe_path" {
						t.Fatalf("%s through %s: %#v", operation, reached, failure)
					}
				}
			}
			requireOutsideUnchanged(t, outside, "sentinel.md", "outside")
		})
	}
}
