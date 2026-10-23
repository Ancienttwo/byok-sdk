//go:build !darwin && !windows

package main

import (
	"errors"
	"os"
)

func platformStrictSync(file *os.File) error { return file.Sync() }

// checkRootVolume has no volume rule here: dev and ino identify the root on
// every volume.
func checkRootVolume(*os.Root) error { return nil }

func sameVolume(a, b os.FileInfo) (bool, error) {
	left, err := identityForRoot(nil, a)
	if err != nil {
		return false, err
	}
	right, err := identityForRoot(nil, b)
	if err != nil {
		return false, err
	}
	if left.Kind != "unix" || right.Kind != "unix" {
		return false, errors.New("home volume identity is not proven")
	}
	return left.Dev == right.Dev, nil
}
