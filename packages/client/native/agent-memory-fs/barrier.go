package main

import (
	"errors"
	"os"
	"path/filepath"
)

// These test seams delegate to real operations in the release binary.
var strictSync = platformStrictSync
var beforeFinalCAS = func() {}

// Bind each link to retained parent/child roots. The last root must be the
// already pinned home. Never grant authority for a separately reopened inode.
func syncHomeChain(home string, expected *os.Root) error {
	canonical, err := filepath.EvalSymlinks(home)
	if err != nil {
		return err
	}
	expectedInfo, err := expected.Stat(".")
	if err != nil {
		return err
	}
	var chain []string
	for cursor := canonical; ; cursor = filepath.Dir(cursor) {
		info, err := os.Stat(cursor)
		if err != nil {
			return err
		}
		same, err := sameVolume(expectedInfo, info)
		if err != nil {
			return err
		}
		// The mount itself is pre-existing. Do not flush another parent volume.
		if !same {
			break
		}
		chain = append(chain, cursor)
		if filepath.Dir(cursor) == cursor {
			break
		}
	}
	if len(chain) == 0 {
		return errors.New("home volume changed")
	}
	anchor := chain[len(chain)-1]
	before, err := os.Lstat(anchor)
	if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe volume root")
	}
	root, err := os.OpenRoot(anchor)
	if err != nil {
		return err
	}
	roots := []*os.Root{root}
	defer func() {
		for index := len(roots) - 1; index >= 0; index-- {
			_ = roots[index].Close()
		}
	}()
	info, err := root.Stat(".")
	if err != nil || !os.SameFile(before, info) {
		return errors.New("volume root changed")
	}
	for index := len(chain) - 1; index >= 0; index-- {
		if index != len(chain)-1 {
			parent := roots[len(roots)-1]
			name := filepath.Base(chain[index])
			before, err := parent.Lstat(name)
			if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
				return errors.New("unsafe home chain")
			}
			child, err := parent.OpenRoot(name)
			if err != nil {
				return err
			}
			roots = append(roots, child)
			after, err := child.Stat(".")
			post, postErr := parent.Lstat(name)
			if err != nil || postErr != nil || !os.SameFile(before, after) || !os.SameFile(after, post) {
				return errors.New("home chain changed")
			}
		}
		current := roots[len(roots)-1]
		file, err := current.Open(".")
		if err != nil {
			return err
		}
		if index == 0 {
			actual, statErr := file.Stat()
			if statErr != nil || !os.SameFile(expectedInfo, actual) {
				_ = file.Close()
				return errors.New("pinned home changed")
			}
		}
		syncErr := strictSync(file)
		closeErr := file.Close()
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	// A rename during any barrier invalidates the name-to-object chain.
	for index := 1; index < len(roots); index++ {
		childInfo, err := roots[index].Stat(".")
		entry, entryErr := roots[index-1].Lstat(filepath.Base(chain[len(chain)-1-index]))
		if err != nil || entryErr != nil || !os.SameFile(childInfo, entry) {
			return errors.New("home chain changed after sync")
		}
	}
	// Flush retained parents after the final relation checks as well. A name
	// restored during the first pass is not durable merely because it matches.
	for index := len(roots) - 1; index >= 0; index-- {
		file, err := roots[index].Open(".")
		if err != nil {
			return err
		}
		syncErr := strictSync(file)
		closeErr := file.Close()
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
