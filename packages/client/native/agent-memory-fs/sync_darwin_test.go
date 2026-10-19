//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
)

func TestDarwinStrictSyncPrimitive(t *testing.T) {
	if reflect.ValueOf(strictSync).Pointer() != reflect.ValueOf(platformStrictSync).Pointer() || reflect.ValueOf(fullSync).Pointer() != reflect.ValueOf(fullSyncSyscall).Pointer() {
		t.Fatal("release barrier does not bind the strict primitive")
	}
	file, err := os.Create(filepath.Join(t.TempDir(), "file"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	original := fullSync
	t.Cleanup(func() { fullSync = original })
	calls := 0
	fullSync = func(fd uintptr) syscall.Errno {
		calls++
		if calls == 1 {
			return syscall.EINTR
		}
		return original(fd)
	}
	if err := platformStrictSync(file); err != nil || calls != 2 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	for _, errno := range []syscall.Errno{syscall.ENOTSUP, syscall.EINVAL, syscall.EPERM, syscall.EIO} {
		calls = 0
		fullSync = func(fd uintptr) syscall.Errno { calls++; return errno }
		if err := platformStrictSync(file); err != errno || calls != 1 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
	}
	// The default binding above delegates to actual F_FULLFSYNC. No ordinary
	// fsync call exists in this primitive, including after unsupported errors.
}
