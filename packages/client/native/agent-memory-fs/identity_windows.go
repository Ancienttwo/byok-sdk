//go:build windows

package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	procGetFinalPathNameByHandleW     = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")
	procGetVolumeInformationByHandleW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetVolumeInformationByHandleW")
	procNtQueryVolumeInformationFile  = syscall.NewLazyDLL("ntdll.dll").NewProc("NtQueryVolumeInformationFile")
)

// rootFileSystem and rootRemote are test seams. The release binary queries the volume.
var (
	rootFileSystem = volumeFileSystemName
	rootRemote     = volumeIsRemote
)

// Windows EvalSymlinks fails on some junction ancestors that native handle
// opens admit. Resolve both names with the same handle API and DOS flags;
// never switch to a pathname resolver after a failure.
func platformHomeChainPaths(home, ancestor string, expected *os.Root) (string, string, error) {
	requested, err := os.Stat(home)
	if err != nil {
		return "", "", err
	}
	pinned, err := expected.Stat(".")
	if err != nil || !os.SameFile(requested, pinned) {
		return "", "", errors.New("pinned home name changed")
	}
	canonicalHome, err := pinnedFinalDirectoryName(expected)
	if err != nil {
		return "", "", err
	}
	ancestorRoot, err := os.OpenRoot(ancestor)
	if err != nil {
		return "", "", err
	}
	defer ancestorRoot.Close()
	canonicalAncestor, err := pinnedFinalDirectoryName(ancestorRoot)
	return canonicalHome, canonicalAncestor, err
}

func pinnedFinalDirectoryName(root *os.Root) (string, error) {
	file, err := root.Open(".")
	if err != nil {
		return "", failure("root_resolution_failed", "directory name handle is unavailable")
	}
	defer file.Close()
	// FILE_NAME_NORMALIZED | VOLUME_NAME_DOS are both zero. Use this exact
	// selection for home and ancestor so extended drive and UNC names agree.
	needed, _, _ := procGetFinalPathNameByHandleW.Call(file.Fd(), 0, 0, 0)
	if needed == 0 {
		return "", failure("root_resolution_failed", "GetFinalPathNameByHandleW failed")
	}
	buffer := make([]uint16, needed)
	written, _, _ := procGetFinalPathNameByHandleW.Call(file.Fd(), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
	if written == 0 || written >= uintptr(len(buffer)) {
		return "", failure("root_resolution_failed", "GetFinalPathNameByHandleW failed or directory name changed")
	}
	return normalizeFinalDirectoryName(syscall.UTF16ToString(buffer[:written]))
}

func normalizeFinalDirectoryName(name string) (string, error) {
	if strings.HasPrefix(name, `\\?\UNC\`) {
		name = `\\` + strings.TrimPrefix(name, `\\?\UNC\`)
	} else if strings.HasPrefix(name, `\\?\`) {
		name = strings.TrimPrefix(name, `\\?\`)
	} else {
		return "", failure("root_resolution_failed", "GetFinalPathNameByHandleW returned a non-DOS path")
	}
	if !filepath.IsAbs(name) {
		return "", failure("root_resolution_failed", "GetFinalPathNameByHandleW returned a non-absolute path")
	}
	return filepath.Clean(name), nil
}

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
