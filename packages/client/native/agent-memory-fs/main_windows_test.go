//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsRootIdentityUsesNativeHandleFields(t *testing.T) {
	home := t.TempDir()
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	info, err := root.Stat(".")
	if err != nil {
		t.Fatal(err)
	}
	identity, err := identityForRoot(root, info)
	if err != nil {
		t.Fatal(err)
	}
	if identity.Kind != "windows" || identity.VolumeSerial == "" || identity.FileIndex == "" {
		t.Fatalf("incomplete native Windows root identity: %#v", identity)
	}
}

func TestWindowsJunctionRootIsRefusedAndPreservesOutsideSentinel(t *testing.T) {
	parent := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel.txt")
	if err := os.WriteFile(sentinel, []byte("outside sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(parent, "junction")
	makeReparsePoint(t, "junction", junction, outside)

	// The identity is the junction target's, so only the junction check can
	// refuse this open.
	opened, protocolErr := openSession(openRequest{
		ID:               "windows-junction",
		Protocol:         protocolVersion,
		Op:               "open",
		Root:             junction,
		ExpectedIdentity: identityForTest(t, outside),
	})
	if opened != nil || protocolErr == nil || protocolErr.code != "unsafe_root" {
		t.Fatalf("a junction home must be unsafe_root, got session=%v error=%v", opened, protocolErr)
	}
	content, err := os.ReadFile(sentinel)
	if err != nil || string(content) != "outside sentinel" {
		t.Fatalf("outside sentinel changed: %q, %v", content, err)
	}
}

// Every other open test queries the real NTFS temp volume. Here the seam
// reports another file system, or a failed query, for the same home.
func TestWindowsOpenAdmitsOnlyNTFS(t *testing.T) {
	for _, volume := range []struct {
		name string
		err  error
	}{{"ReFS", nil}, {"FAT32", nil}, {"exFAT", nil}, {"query-failed", errors.New("query failed")}} {
		t.Run(volume.name, func(t *testing.T) {
			home := newMemoryHome(t)
			original := rootFileSystem
			t.Cleanup(func() { rootFileSystem = original })
			rootFileSystem = func(*os.Root) (string, error) { return volume.name, volume.err }
			opened, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identityForTest(t, home)})
			if opened != nil || failure == nil || failure.code != "unsafe_root" {
				t.Fatalf("file system %q (error %v) admitted: session=%v error=%v", volume.name, volume.err, opened, failure)
			}
		})
	}
}
