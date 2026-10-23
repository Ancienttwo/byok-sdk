//go:build darwin

package main

import (
	"errors"
	"os"
	"syscall"
)

// No File.Sync fallback: Go otherwise falls back to fsync on ENOTSUP.
func fullSyncSyscall(fd uintptr) syscall.Errno {
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_FULLFSYNC, 0)
	return errno
}

var fullSync = fullSyncSyscall

// rootStatfs is a test seam. The release binary queries the volume.
var rootStatfs = syscall.Fstatfs

// mntLocal is MNT_LOCAL from <sys/mount.h>. The syscall package omits it.
const mntLocal = 0x00001000

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

// checkRootVolume admits a local volume only. On SMB, NFS, AFP or another
// remote mount, F_FULLFSYNC and rename durability depend on the server. The
// query uses the pinned root handle, not the path, and a failed query also
// refuses the root.
func checkRootVolume(root *os.Root) error {
	file, err := root.Open(".")
	if err != nil {
		return err
	}
	defer file.Close()
	var stat syscall.Statfs_t
	if err := rootStatfs(int(file.Fd()), &stat); err != nil {
		return err
	}
	if stat.Flags&mntLocal == 0 {
		return errors.New("root volume is not local")
	}
	return nil
}
