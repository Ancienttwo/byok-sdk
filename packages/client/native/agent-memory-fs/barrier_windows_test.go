//go:build windows

package main

import (
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
// Production Windows admission stays closed.
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

// Platform-refusal check only: openSession returns unsupported_platform before
// it reads any path. Junction fixtures do not exercise traversal or containment.
// Fixture setup failures still fail this check. No storage barrier is tested.
func TestWindowsPlatformRefusalWithJunctionFixtures(t *testing.T) {
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel.txt")
	if err := os.WriteFile(sentinel, []byte("outside sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, placement := range []string{"ordinary", "root-junction", "ancestor-junction", "notes-junction", "state-junction"} {
		t.Run(placement, func(t *testing.T) {
			parent := t.TempDir()
			home := filepath.Join(parent, "home")
			if err := os.Mkdir(home, 0o700); err != nil {
				t.Fatal(err)
			}
			link := ""
			switch placement {
			case "root-junction":
				if err := os.Remove(home); err != nil {
					t.Fatal(err)
				}
				link = home
			case "ancestor-junction":
				link = filepath.Join(parent, "ancestor")
				home = filepath.Join(link, "home")
			case "notes-junction":
				link = filepath.Join(home, "notes")
			case "state-junction":
				link = filepath.Join(home, ".byok")
			}
			if link != "" {
				if output, err := exec.Command("cmd", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
					t.Fatalf("required junction setup failed: %v (%s)", err, output)
				}
				defer os.Remove(link) // Remove the junction, never its target.
			}
			opened, err := openSession(openRequest{ID: "denial", Protocol: protocolVersion, Op: "open", Root: home,
				ExpectedIdentity: rootIdentity{Kind: "windows", VolumeSerial: "0", FileIndex: "0"}})
			if opened != nil || err == nil || err.code != "unsupported_platform" {
				t.Fatalf("unproved Windows authority admitted: session=%v error=%v", opened, err)
			}
			content, readErr := os.ReadFile(sentinel)
			if readErr != nil || string(content) != "outside sentinel" {
				t.Fatalf("outside sentinel changed: %q %v", content, readErr)
			}
		})
	}
}
