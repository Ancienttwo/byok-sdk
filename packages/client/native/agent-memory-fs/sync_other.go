//go:build !darwin

package main

import (
	"errors"
	"os"
	"runtime"
)

func platformStrictSync(file *os.File) error { return file.Sync() }

func sameVolume(a, b os.FileInfo) (bool, error) {
	if runtime.GOOS == "windows" {
		return false, errors.New("Windows home volume proof is not admitted")
	}
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
