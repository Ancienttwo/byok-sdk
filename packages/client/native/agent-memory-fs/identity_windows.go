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

var (
	procGetVolumeInformationByHandleW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetVolumeInformationByHandleW")
	procNtQueryVolumeInformationFile  = syscall.NewLazyDLL("ntdll.dll").NewProc("NtQueryVolumeInformationFile")
)

// rootFileSystem and rootRemote are test seams. The release binary queries the volume.
var (
	rootFileSystem = volumeFileSystemName
	rootRemote     = volumeIsRemote
)

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

// checkRootVolume admits local NTFS only. There the volume serial and the
// 64-bit file index identify one directory. ReFS file IDs have 128 bits, so
// the 64-bit index is not unique, and a FAT file ID changes when its directory
// entry moves. A remote volume is refused before the file system name: an SMB
// share whose server reports NTFS has no local flush or identity guarantee.
// The containment tests also run on local NTFS only.
func checkRootVolume(root *os.Root) error {
	remote, err := rootRemote(root)
	if err != nil {
		return err
	}
	if remote {
		return errors.New("root volume is remote")
	}
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

// volumeIsRemote reports a redirected volume from the pinned handle: the
// FILE_REMOTE_DEVICE characteristic or a network file system device type.
func volumeIsRemote(root *os.Root) (bool, error) {
	file, err := root.Open(".")
	if err != nil {
		return false, err
	}
	defer file.Close()
	const (
		fileFsDeviceInformation     = 4
		fileDeviceNetworkFileSystem = 0x14
		fileRemoteDevice            = 0x10
	)
	var status struct{ Status, Information uintptr }
	var device struct{ DeviceType, Characteristics uint32 }
	code, _, _ := procNtQueryVolumeInformationFile.Call(file.Fd(), uintptr(unsafe.Pointer(&status)),
		uintptr(unsafe.Pointer(&device)), unsafe.Sizeof(device), fileFsDeviceInformation)
	if code != 0 {
		return false, fmt.Errorf("NtQueryVolumeInformationFile failed: 0x%x", code)
	}
	return device.Characteristics&fileRemoteDevice != 0 || device.DeviceType == fileDeviceNetworkFileSystem, nil
}
