//go:build !darwin

package main

import "os"

func platformStrictSync(file *os.File) error { return file.Sync() }

func sameVolume(a, b os.FileInfo) (bool, error) { return true, nil }
