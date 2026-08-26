//go:build !windows

package main

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

// identityForRoot uses the decimal dev/ino representation produced by Node's
// fs.Stat bigint fields on Unix. The tagged shape is part of protocol v1.
func identityForRoot(_ *os.Root, info fs.FileInfo) (rootIdentity, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return rootIdentity{}, fmt.Errorf("unsupported file identity")
	}
	return rootIdentity{
		Kind: "unix",
		Dev:  fmt.Sprintf("%d", stat.Dev),
		Ino:  fmt.Sprintf("%d", stat.Ino),
	}, nil
}
