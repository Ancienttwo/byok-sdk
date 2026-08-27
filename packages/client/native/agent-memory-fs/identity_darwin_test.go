//go:build darwin

package main

import (
	"io/fs"
	"syscall"
	"testing"
	"time"
)

type syntheticDarwinFileInfo struct {
	stat *syscall.Stat_t
}

func (syntheticDarwinFileInfo) Name() string       { return "home" }
func (syntheticDarwinFileInfo) Size() int64        { return 0 }
func (syntheticDarwinFileInfo) Mode() fs.FileMode  { return fs.ModeDir }
func (syntheticDarwinFileInfo) ModTime() time.Time { return time.Time{} }
func (syntheticDarwinFileInfo) IsDir() bool        { return true }
func (info syntheticDarwinFileInfo) Sys() any      { return info.stat }

func TestDarwinRootIdentityMatchesLibuvUnsignedDeviceWidening(t *testing.T) {
	identity, err := identityForRoot(nil, syntheticDarwinFileInfo{
		stat: &syscall.Stat_t{Dev: -1, Ino: 42},
	})
	if err != nil {
		t.Fatal(err)
	}

	// libuv stores Darwin's signed 32-bit dev_t in uv_stat_t.st_dev, a
	// uint64_t. Node exposes that uint64 value through bigint Stats.
	if identity.Dev != "18446744073709551615" || identity.Ino != "42" {
		t.Fatalf("Darwin root identity = %#v", identity)
	}
	if !validRootIdentity(identity) {
		t.Fatalf("Darwin root identity is not accepted by the helper protocol: %#v", identity)
	}
}
