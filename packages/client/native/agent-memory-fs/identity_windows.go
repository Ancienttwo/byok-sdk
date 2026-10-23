//go:build windows

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"syscall"
	"unsafe"
)

var procGetVolumeInformationByHandleW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetVolumeInformationByHandleW")

// rootFileSystem is a test seam. The release binary queries the volume.
var rootFileSystem = volumeFileSystemName

// identityForRoot intentionally obtains the Windows identity from the pinned
// handle rather than a path Stat result, and uses the same tagged identity
// contract as Node/libuv.
func identityForRoot(root *os.Root, _ fs.FileInfo) (rootIdentity, error) {
	file, err := root.Open(".")
	if err != nil {
		return rootIdentity{}, err
	}
	defer file.Close()
	var information syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &information); err != nil {
		return rootIdentity{}, err
	}
	index := uint64(information.FileIndexHigh)<<32 | uint64(information.FileIndexLow)
	return rootIdentity{
		Kind:         "windows",
		VolumeSerial: fmt.Sprintf("%d", information.VolumeSerialNumber),
		FileIndex:    fmt.Sprintf("%d", index),
	}, nil
}

// linkCount reads the hard link count from the open handle. Go's Windows
// FileInfo has no link count.
func linkCount(file *os.File, _ fs.FileInfo) (uint64, error) {
	var information syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &information); err != nil {
		return 0, err
	}
	return uint64(information.NumberOfLinks), nil
}

// checkRootVolume admits NTFS only. There the volume serial and the 64-bit
// file index identify one directory. ReFS file IDs have 128 bits, so the
// 64-bit index is not unique, and a FAT file ID changes when its directory
// entry moves. The containment tests also run on NTFS only.
func checkRootVolume(root *os.Root) error {
	name, err := rootFileSystem(root)
	if err != nil {
		return err
	}
	if name != "NTFS" {
		return errors.New("root volume is not NTFS")
	}
	return nil
}

func volumeFileSystemName(root *os.Root) (string, error) {
	file, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer file.Close()
	var name [syscall.MAX_PATH + 1]uint16
	ok, _, callErr := procGetVolumeInformationByHandleW.Call(file.Fd(), 0, 0, 0, 0, 0, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
	if ok == 0 {
		return "", callErr
	}
	return syscall.UTF16ToString(name[:]), nil
}
