//go:build windows

package main

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

var (
	ntdll                     = syscall.NewLazyDLL("ntdll.dll")
	procNtCreateFile          = ntdll.NewProc("NtCreateFile")
	procRtlNtStatusToDosError = ntdll.NewProc("RtlNtStatusToDosError")
)

type ntUnicodeString struct {
	Length, MaximumLength uint16
	Buffer                *uint16
}

type ntObjectAttributes struct {
	Length                   uint32
	RootDirectory            syscall.Handle
	ObjectName               *ntUnicodeString
	Attributes               uint32
	SecurityDescriptor       uintptr
	SecurityQualityOfService uintptr
}

// FlushFileBuffers needs write access. os.Root opens a directory read-only, so
// NTFS refuses that flush with access denied. NtCreateFile with an empty name
// relative to the pinned handle opens that directory again, as Root.Open(".")
// does, without a path. ReOpenFile refuses write access to these handles.
// The new handle must also have the same volume and file index.
func platformStrictSync(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return file.Sync()
	}
	const (
		fileWriteData        = 0x2
		fileReadAttributes   = 0x80
		fileOpen             = 1
		fileDirectoryFile    = 0x1
		fileSynchronousIO    = 0x20
		fileOpenForBackup    = 0x4000
		fileOpenReparsePoint = 0x200000
		share                = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE
	)
	original := syscall.Handle(file.Fd())
	var name ntUnicodeString
	attributes := ntObjectAttributes{Length: uint32(unsafe.Sizeof(ntObjectAttributes{})), RootDirectory: original, ObjectName: &name}
	var ioStatus struct{ Status, Information uintptr }
	var handle syscall.Handle
	status, _, _ := procNtCreateFile.Call(uintptr(unsafe.Pointer(&handle)), fileWriteData|fileReadAttributes|syscall.SYNCHRONIZE,
		uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(&ioStatus)), 0, 0, share, fileOpen,
		fileDirectoryFile|fileSynchronousIO|fileOpenForBackup|fileOpenReparsePoint, 0, 0)
	if status != 0 {
		code, _, _ := procRtlNtStatusToDosError.Call(status)
		return syscall.Errno(code)
	}
	flushErr := flushSameObject(original, handle)
	closeErr := syscall.CloseHandle(handle)
	if flushErr != nil {
		return flushErr
	}
	return closeErr
}

func flushSameObject(original, reopened syscall.Handle) error {
	var before, after syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(original, &before); err != nil {
		return err
	}
	if err := syscall.GetFileInformationByHandle(reopened, &after); err != nil {
		return err
	}
	if before.VolumeSerialNumber != after.VolumeSerialNumber || before.FileIndexHigh != after.FileIndexHigh || before.FileIndexLow != after.FileIndexLow {
		return errors.New("reopened directory is another object")
	}
	return syscall.FlushFileBuffers(reopened)
}

func sameVolume(os.FileInfo, os.FileInfo) (bool, error) {
	return false, errors.New("Windows home volume proof is not admitted")
}
