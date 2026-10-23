//go:build darwin

package main

import (
	"errors"
	"os"
	"reflect"
	"syscall"
	"testing"
)

// autofsMount is an automount trigger on every macOS install. Its fstatfs
// flags have no MNT_LOCAL, and an ordinary user can open it.
const autofsMount = "/System/Volumes/Data/home"

func TestDarwinRootVolumeBindsFstatfs(t *testing.T) {
	if reflect.ValueOf(rootStatfs).Pointer() != reflect.ValueOf(syscall.Fstatfs).Pointer() {
		t.Fatal("release volume check does not bind fstatfs")
	}
	home := newMemoryHome(t)
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := checkRootVolume(root); err != nil {
		t.Fatalf("local temp volume refused: %v", err)
	}
}

// Every other open test queries the real local temp volume. Here the seam
// reports a volume without MNT_LOCAL, or a failed query, for the same home.
func TestDarwinOpenRefusesNonLocalVolume(t *testing.T) {
	for _, volume := range []struct {
		name  string
		flags uint32
		err   error
	}{{"not-local", 0x04500000, nil}, {"query-failed", mntLocal, errors.New("query failed")}} {
		t.Run(volume.name, func(t *testing.T) {
			home := newMemoryHome(t)
			original := rootStatfs
			t.Cleanup(func() { rootStatfs = original })
			rootStatfs = func(fd int, stat *syscall.Statfs_t) error {
				stat.Flags = volume.flags
				return volume.err
			}
			opened, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identityForTest(t, home)})
			if opened != nil || failure == nil || failure.code != "unsafe_root" {
				t.Fatalf("volume %q (error %v) admitted: session=%v error=%v", volume.name, volume.err, opened, failure)
			}
		})
	}
}

// The real fstatfs on a mount without MNT_LOCAL. CI sets
// BYOK_REQUIRE_DARWIN_NONLOCAL_VOLUME=1, so a missing mount fails there.
func TestDarwinOpenRefusesRealNonLocalMount(t *testing.T) {
	root, err := os.OpenRoot(autofsMount)
	if err != nil {
		if os.Getenv("BYOK_REQUIRE_DARWIN_NONLOCAL_VOLUME") == "1" {
			t.Fatalf("non-local mount %s is required: %v", autofsMount, err)
		}
		t.Skipf("non-local mount %s is unavailable: %v", autofsMount, err)
	}
	defer root.Close()
	file, err := root.Open(".")
	if err != nil {
		t.Fatal(err)
	}
	var stat syscall.Statfs_t
	err = syscall.Fstatfs(int(file.Fd()), &stat)
	file.Close()
	if err != nil || stat.Flags&mntLocal != 0 {
		t.Fatalf("%s is not a non-local mount: flags=%#x error=%v", autofsMount, stat.Flags, err)
	}
	// Only the MNT_LOCAL branch returns this error.
	if err := checkRootVolume(root); err == nil || err.Error() != "root volume is not local" {
		t.Fatalf("%s volume check: %v", autofsMount, err)
	}
	opened, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: autofsMount, ExpectedIdentity: identityForTest(t, autofsMount)})
	if opened != nil || failure == nil || failure.code != "unsafe_root" {
		t.Fatalf("non-local mount admitted: session=%v error=%v", opened, failure)
	}
}
