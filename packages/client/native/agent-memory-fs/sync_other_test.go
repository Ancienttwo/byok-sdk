//go:build !darwin && !windows

package main

import (
	"os"
	"syscall"
	"testing"
)

type volumeTestInfo struct {
	os.FileInfo
	raw any
}

func (info volumeTestInfo) Sys() any { return info.raw }

func TestOtherVolumeIdentityFailsClosed(t *testing.T) {
	info, err := os.Stat(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	same, err := sameVolume(info, info)
	if err != nil || !same {
		t.Fatalf("real identity: same=%v err=%v", same, err)
	}
	stat := *info.Sys().(*syscall.Stat_t)
	stat.Dev ^= 1
	same, err = sameVolume(info, volumeTestInfo{FileInfo: info, raw: &stat})
	if err != nil || same {
		t.Fatalf("different device: same=%v err=%v", same, err)
	}
	for _, raw := range []any{nil, struct{}{}} {
		same, err = sameVolume(info, volumeTestInfo{FileInfo: info, raw: raw})
		if same || err == nil {
			t.Fatalf("unproven identity: same=%v err=%v", same, err)
		}
	}
}
