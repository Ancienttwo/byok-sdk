//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"testing"
	"unsafe"
)

// Diagnostic only: it logs which call refuses a writable directory handle.
func TestWindowsDirectoryReopenDiagnosticsOnly(t *testing.T) {
	ntdll := syscall.NewLazyDLL("ntdll.dll")
	queryObject := ntdll.NewProc("NtQueryObject")
	createFile := ntdll.NewProc("NtCreateFile")
	flushEx := ntdll.NewProc("NtFlushBuffersFileEx")
	granted := func(handle syscall.Handle) string {
		var info struct {
			Attributes, GrantedAccess, HandleCount, PointerCount uint32
			Reserved                                              [10]uint32
		}
		status, _, _ := queryObject.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), 0)
		return fmt.Sprintf("status=%#x granted=%#x", uint32(status), info.GrantedAccess)
	}
	flush := func(label string, handle syscall.Handle) {
		var ioStatus struct{ Status, Information uintptr }
		status, _, _ := flushEx.Call(uintptr(handle), 0, 0, 0, uintptr(unsafe.Pointer(&ioStatus)))
		t.Logf("DIAGNOSTIC %s: %s FlushFileBuffers=%v NtFlushBuffersFileEx=%s", label, granted(handle), syscall.FlushFileBuffers(handle), fmt.Sprintf("%#x", uint32(status)))
	}

	home := t.TempDir()
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	directory, err := root.Open(".")
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	original := syscall.Handle(directory.Fd())
	t.Logf("DIAGNOSTIC Root.Open(.) handle: %s", granted(original))

	const share = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE
	for _, access := range []struct {
		name string
		mask uint32
	}{
		{"GENERIC_READ|GENERIC_WRITE", syscall.GENERIC_READ | syscall.GENERIC_WRITE},
		{"GENERIC_WRITE", syscall.GENERIC_WRITE},
		{"FILE_WRITE_DATA", 0x2},
		{"FILE_APPEND_DATA", 0x4},
		{"FILE_WRITE_ATTRIBUTES", 0x100},
	} {
		handle, _, callErr := procReOpenFile.Call(uintptr(original), uintptr(access.mask), share, syscall.FILE_FLAG_BACKUP_SEMANTICS)
		if syscall.Handle(handle) == syscall.InvalidHandle {
			t.Logf("DIAGNOSTIC ReOpenFile(%s): %v", access.name, callErr)
			continue
		}
		flush("ReOpenFile("+access.name+")", syscall.Handle(handle))
		syscall.CloseHandle(syscall.Handle(handle))
	}

	// NtCreateFile relative to the pinned handle with an empty name.
	type unicodeString struct {
		Length, MaximumLength uint16
		Buffer                *uint16
	}
	type objectAttributes struct {
		Length                   uint32
		RootDirectory            syscall.Handle
		ObjectName               *unicodeString
		Attributes               uint32
		SecurityDescriptor       uintptr
		SecurityQualityOfService uintptr
	}
	var name unicodeString
	attributes := objectAttributes{Length: uint32(unsafe.Sizeof(objectAttributes{})), RootDirectory: original, ObjectName: &name}
	var ioStatus struct{ Status, Information uintptr }
	var handle syscall.Handle
	const fileGenericWrite = 0x120116
	const fileOpen = 1
	const options = 0x1 | 0x20 | 0x4000 // FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT
	status, _, _ := createFile.Call(uintptr(unsafe.Pointer(&handle)), fileGenericWrite|syscall.SYNCHRONIZE, uintptr(unsafe.Pointer(&attributes)),
		uintptr(unsafe.Pointer(&ioStatus)), 0, 0, share, fileOpen, options, 0, 0)
	if status != 0 {
		t.Logf("DIAGNOSTIC NtCreateFile(relative, FILE_GENERIC_WRITE): NTSTATUS=%s", fmt.Sprintf("%#x", uint32(status)))
	} else {
		flush("NtCreateFile(relative, FILE_GENERIC_WRITE)", handle)
		syscall.CloseHandle(handle)
	}

	// The same directory by path, for comparison with the existing diagnostic.
	path, err := syscall.UTF16PtrFromString(home)
	if err != nil {
		t.Fatal(err)
	}
	byPath, err := syscall.CreateFile(path, syscall.GENERIC_READ|syscall.GENERIC_WRITE, share, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Logf("DIAGNOSTIC CreateFileW(path): %v", err)
		return
	}
	flush("CreateFileW(path)", byPath)
	syscall.CloseHandle(byPath)
}
