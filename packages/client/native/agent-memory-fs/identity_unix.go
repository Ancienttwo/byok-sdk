//go:build !windows

package main

import (
	"fmt"
	"io/fs"
	"os"
	"syscall"
)

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
