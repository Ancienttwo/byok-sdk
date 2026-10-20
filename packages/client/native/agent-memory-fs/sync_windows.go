//go:build windows

package main

import (
	"errors"
	"os"
	"syscall"
)

var procReOpenFile = syscall.NewLazyDLL("kernel32.dll").NewProc("ReOpenFile")

// FlushFileBuffers needs a handle with GENERIC_WRITE. os.Root opens a
// directory read-only, so NTFS refuses that flush with access denied.
// ReOpenFile gives a second handle to the same object. It does not resolve a
// path, so a rename of the directory name cannot redirect the barrier. Its
// documentation names CreateFile handles, and os.Root uses NtCreateFile, so
// the barrier also proves the new handle has the same volume and file index.
func platformStrictSync(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return file.Sync()
	}
	const share = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE | syscall.FILE_SHARE_DELETE
	handle, _, callErr := procReOpenFile.Call(file.Fd(), syscall.GENERIC_READ|syscall.GENERIC_WRITE, share, syscall.FILE_FLAG_BACKUP_SEMANTICS)
	if syscall.Handle(handle) == syscall.InvalidHandle {
		return callErr
	}
	flushErr := flushSameObject(syscall.Handle(file.Fd()), syscall.Handle(handle))
	closeErr := syscall.CloseHandle(syscall.Handle(handle))
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
