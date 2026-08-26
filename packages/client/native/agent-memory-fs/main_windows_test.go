//go:build windows

package main

import (
	"os"
	"os/exec"
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

func TestWindowsJunctionAdmissionRemainsClosedAndPreservesOutsideSentinel(t *testing.T) {
	parent := t.TempDir()
	outside := t.TempDir()
	sentinel := filepath.Join(outside, "sentinel.txt")
	if err := os.WriteFile(sentinel, []byte("outside sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(parent, "junction")
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", junction, outside).CombinedOutput(); err != nil {
		t.Skipf("Windows host cannot create a junction for the native falsifier: %v (%s)", err, output)
	}

	opened, protocolErr := openSession(openRequest{
		ID:               "windows-junction",
		Protocol:         protocolVersion,
		Op:               "open",
		Root:             junction,
		ExpectedIdentity: rootIdentity{Kind: "windows", VolumeSerial: "0", FileIndex: "0"},
	})
	if opened != nil || protocolErr == nil || protocolErr.code != "unsupported_platform" {
		t.Fatalf("Windows admission must remain fail-closed, got session=%v error=%v", opened, protocolErr)
	}
	content, err := os.ReadFile(sentinel)
	if err != nil || string(content) != "outside sentinel" {
		t.Fatalf("outside sentinel changed: %q, %v", content, err)
	}
}
