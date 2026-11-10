//go:build !windows

package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// Unix retains its existing pathname canonicalization and volume barrier.
func platformHomeChainPaths(home, ancestor string, _ *os.Root) (string, string, error) {
	canonicalHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", "", err
	}
	canonicalAncestor, err := filepath.EvalSymlinks(ancestor)
	return canonicalHome, canonicalAncestor, err
}

// identityForRoot uses the decimal dev/ino representation produced by Node's
// fs.Stat bigint fields on Unix. libuv widens both fields into uint64_t before
// Node exposes them, including Darwin's signed 32-bit dev_t.
func identityForRoot(_ *os.Root, info fs.FileInfo) (rootIdentity, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return rootIdentity{}, fmt.Errorf("unsupported file identity")
	}
	return rootIdentity{
		Kind: "unix",
		Dev:  fmt.Sprintf("%d", uint64(stat.Dev)),
		Ino:  fmt.Sprintf("%d", uint64(stat.Ino)),
	}, nil
}

// linkCount reads the hard link count from the Stat result of an open file.
func linkCount(_ *os.File, info fs.FileInfo) (uint64, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("unsupported file identity")
	}
	return uint64(stat.Nlink), nil
}
