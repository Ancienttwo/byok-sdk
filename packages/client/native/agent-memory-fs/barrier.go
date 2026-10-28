package main

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
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
	return syncPinnedHomeChain(chain, expected)
}

// Prepared W2 scheme B primitive. Production Windows open remains unchanged:
// the private request cannot yet convey the maintainer-selected ancestor root.
func syncHomeChainFrom(home, ancestor string, expected *os.Root) error {
	if !filepath.IsAbs(home) || !filepath.IsAbs(ancestor) {
		return errors.New("home chain requires absolute paths")
	}
	canonicalHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		return err
	}
	canonicalAncestor, err := filepath.EvalSymlinks(ancestor)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(canonicalAncestor, canonicalHome)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errors.New("chain root is not an ancestor of home")
	}
	chain := []string{canonicalAncestor}
	if relative != "." {
		for _, part := range strings.Split(relative, string(filepath.Separator)) {
			chain = append(chain, filepath.Join(chain[len(chain)-1], part))
		}
	}
	slices.Reverse(chain)
	return syncPinnedHomeChain(chain, expected)
}

func samePinnedHomeVolume(left, right *os.Root) (bool, error) {
	leftInfo, err := left.Stat(".")
	if err != nil {
		return false, err
	}
	rightInfo, err := right.Stat(".")
	if err != nil {
		return false, err
	}
	leftID, err := identityForRoot(left, leftInfo)
	if err != nil {
		return false, err
	}
	rightID, err := identityForRoot(right, rightInfo)
	if err != nil {
		return false, err
	}
	if leftID.Kind != rightID.Kind {
		return false, errors.New("home volume identity changed")
	}
	if leftID.Kind == "windows" {
		return leftID.VolumeSerial == rightID.VolumeSerial, nil
	}
	return leftID.Dev == rightID.Dev, nil
}

func syncPinnedHomeChain(chain []string, expected *os.Root) error {
	expectedInfo, err := expected.Stat(".")
	if err != nil {
		return err
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
		if same, err := samePinnedHomeVolume(expected, current); err != nil || !same {
			return errors.New("home chain crossed a volume")
		}
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
