//go:build windows

package main

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// identityForRoot intentionally obtains the Windows identity from the pinned
// handle rather than a path Stat result. Windows open is currently fail-closed
// in openSession until the native reparse/junction matrix is accepted, but this
// implementation is kept cross-buildable so the eventual admission uses the
// same tagged identity contract as Node/libuv.
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
