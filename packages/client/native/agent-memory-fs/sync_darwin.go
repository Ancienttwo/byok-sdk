//go:build darwin

package main

import (
	"os"
	"syscall"
)

// No File.Sync fallback: Go otherwise falls back to fsync on ENOTSUP.
func fullSyncSyscall(fd uintptr) syscall.Errno {
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_FULLFSYNC, 0)
	return errno
}

var fullSync = fullSyncSyscall

func platformStrictSync(file *os.File) error {
	for {
		errno := fullSync(file.Fd())
		if errno == syscall.EINTR {
			continue
		}
		if errno != 0 {
			return errno
		}
		return nil
	}
}

func sameVolume(a, b os.FileInfo) (bool, error) {
	x, ok := a.Sys().(*syscall.Stat_t)
	y, other := b.Sys().(*syscall.Stat_t)
	if !ok || !other {
		return false, syscall.EINVAL
	}
	return x.Dev == y.Dev, nil
}
