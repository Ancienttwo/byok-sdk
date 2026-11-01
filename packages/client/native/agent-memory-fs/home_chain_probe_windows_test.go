//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

// W2 experiment (docs/plans/2026-10-22-605-windows-memory.md §5). It walks each
// home chain from the home to its volume root with the production primitives:
// os.OpenRoot, Root.Open(".") and platformStrictSync. It logs one W2 line for
// each directory. DIAGNOSTIC ONLY: an ancestor result is data, not a pass or a
// failure. The test fails only when a fixture cannot be made or when the home
// itself cannot flush, because each write already flushes the home.

var procGetNamedSecurityInfoW = syscall.NewLazyDLL("advapi32.dll").NewProc("GetNamedSecurityInfoW")

func TestWindowsHomeChainProbeDiagnosticsOnly(t *testing.T) {
	for _, name := range []string{"USERNAME", "USERPROFILE", "LOCALAPPDATA", "TEMP", "TMP"} {
		t.Logf("W2 env %s=%q", name, os.Getenv(name))
	}
	output, err := exec.Command("whoami", "/priv").CombinedOutput()
	for _, line := range strings.Split(string(output), "\n") {
		if strings.Contains(line, "SeBackupPrivilege") || strings.Contains(line, "SeRestorePrivilege") {
			t.Logf("W2 token %s", strings.Join(strings.Fields(line), " "))
		}
	}
	t.Logf("W2 token whoami=%v", err)
	// The environment comes from the parent process. The token names the
	// profile of the account that really runs this test.
	var token syscall.Token
	profile := ""
	if err := syscall.OpenProcessToken(syscall.Handle(^uintptr(0)), syscall.TOKEN_QUERY, &token); err == nil {
		profile, err = token.GetUserProfileDirectory()
		t.Logf("W2 token profile=%q err=%v", profile, err)
		_ = token.Close()
	}

	temp := t.TempDir()
	created := filepath.Join(temp, "host", "homes", "agent")
	probeChain(t, "created-temp", mkdirChain(t, temp, created), created, true)

	target := filepath.Join(temp, "real", "homes", "agent")
	mkdirChain(t, temp, target)
	makeReparsePoint(t, "junction", filepath.Join(temp, "link"), filepath.Join(temp, "real"))
	probeChain(t, "junction-ancestor", nil, filepath.Join(temp, "link", "homes", "agent"), false)

	local := ""
	if profile != "" {
		local = filepath.Join(profile, "AppData", "Local")
	}
	for _, existing := range []struct{ label, path string }{{"existing-localappdata", local}, {"existing-profile", profile}} {
		if info, err := os.Stat(existing.path); existing.path == "" || err != nil || !info.IsDir() {
			t.Logf("W2 chain=%s absent: %q %v", existing.label, existing.path, err)
			continue
		}
		probeChain(t, existing.label, nil, existing.path, false)
	}
	if info, err := os.Stat(local); local != "" && err == nil && info.IsDir() {
		product := filepath.Join(local, fmt.Sprintf("byok-w2-probe-%d", time.Now().UnixNano()))
		t.Cleanup(func() { _ = os.RemoveAll(product) })
		home := filepath.Join(product, "homes", "agent")
		probeChain(t, "created-localappdata", mkdirChain(t, local, home), home, true)
	}
}

// mkdirChain creates each missing directory below base, one Mkdir at a time,
// as materializeDirectory in agent-home.ts does. It returns the new paths.
func mkdirChain(t *testing.T, base, leaf string) map[string]bool {
	t.Helper()
	relative, err := filepath.Rel(base, leaf)
	if err != nil {
		t.Fatal(err)
	}
	made := map[string]bool{}
	cursor := base
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		cursor = filepath.Join(cursor, part)
		if err := os.Mkdir(cursor, 0o700); err != nil {
			t.Fatalf("W2 fixture mkdir %s: %v", cursor, err)
		}
		// The walk uses canonical names: a short name such as RUNNER~1 expands.
		canonical, err := filepath.EvalSymlinks(cursor)
		if err != nil {
			t.Fatalf("W2 fixture canonical %s: %v", cursor, err)
		}
		made[canonical] = true
	}
	return made
}

func probeChain(t *testing.T, label string, made map[string]bool, leaf string, requireHomeFlush bool) {
	t.Helper()
	canonical, err := filepath.EvalSymlinks(leaf)
	t.Logf("W2 chain=%s leaf=%q EvalSymlinks=%q err=%v", label, leaf, canonical, err)
	if err != nil {
		canonical = leaf
	}
	var leafSerial uint32
	for depth, cursor := 0, canonical; ; depth, cursor = depth+1, filepath.Dir(cursor) {
		mode, attributes, serial, owner, openErr, flushErr, elapsed := probeDirectory(cursor)
		if depth == 0 {
			leafSerial = serial
			if requireHomeFlush && (openErr != nil || flushErr != nil) {
				t.Fatalf("W2 chain=%s home %q: open=%v flush=%v", label, cursor, openErr, flushErr)
			}
		}
		t.Logf("W2 chain=%s depth=%d path=%q created=%t mode=%v attrs=%#x serial=%d sameVolume=%t owner=%s open=%s flush=%s ms=%.2f",
			label, depth, cursor, made[cursor], mode, attributes, serial, serial == leafSerial, owner, errnoText(openErr), errnoText(flushErr), elapsed.Seconds()*1000)
		if filepath.Dir(cursor) == cursor {
			return
		}
	}
}

// probeDirectory opens path as syncHomeChain opens each link, and flushes it
// with the production directory barrier.
func probeDirectory(path string) (os.FileMode, uint32, uint32, string, error, error, time.Duration) {
	var mode os.FileMode
	if info, err := os.Lstat(path); err == nil {
		mode = info.Mode()
	}
	owner := ownerOf(path)
	root, err := os.OpenRoot(path)
	if err != nil {
		return mode, 0, 0, owner, err, nil, 0
	}
	defer root.Close()
	file, err := root.Open(".")
	if err != nil {
		return mode, 0, 0, owner, err, nil, 0
	}
	defer file.Close()
	var information syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &information); err != nil {
		return mode, 0, 0, owner, err, nil, 0
	}
	start := time.Now()
	flushErr := platformStrictSync(file)
	return mode, information.FileAttributes, information.VolumeSerialNumber, owner, nil, flushErr, time.Since(start)
}

// ownerOf reads the owner SID by name. It is a log field only.
func ownerOf(path string) string {
	const seFileObject, ownerSecurityInformation = 1, 1
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "error:" + err.Error()
	}
	var owner *syscall.SID
	var descriptor uintptr
	status, _, _ := procGetNamedSecurityInfoW.Call(uintptr(unsafe.Pointer(name)), seFileObject, ownerSecurityInformation,
		uintptr(unsafe.Pointer(&owner)), 0, 0, 0, uintptr(unsafe.Pointer(&descriptor)))
	if status != 0 {
		return fmt.Sprintf("error:%d", status)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	sid, err := owner.String()
	if err != nil {
		return "error:" + err.Error()
	}
	if account, domain, _, err := owner.LookupAccount(""); err == nil {
		return fmt.Sprintf("%s(%s\\%s)", sid, domain, account)
	}
	return sid
}

func errnoText(err error) string {
	if err == nil {
		return "ok"
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return fmt.Sprintf("errno=%d(%v)", uintptr(errno), errno)
	}
	return fmt.Sprintf("%q", err.Error())
}
