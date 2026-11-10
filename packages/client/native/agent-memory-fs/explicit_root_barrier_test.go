package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func explicitRootFixture(t *testing.T) (string, string, *os.Root) {
	t.Helper()
	ancestor, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(ancestor, "homes", "team", "agent")
	if err := os.MkdirAll(home, 0700); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	return ancestor, home, root
}

func TestExplicitRootBarrierFlushesOnlySelectedChain(t *testing.T) {
	ancestor, home, root := explicitRootFixture(t)
	chain := []string{ancestor, filepath.Join(ancestor, "homes"), filepath.Join(ancestor, "homes", "team"), home}
	expected := append(append([]string{}, chain...), home, chain[2], chain[1], ancestor)
	original := strictSync
	t.Cleanup(func() { strictSync = original })
	calls := 0
	strictSync = func(file *os.File) error {
		if calls >= len(expected) {
			t.Fatalf("flushed outside the selected chain: %s", file.Name())
		}
		actualInfo, err := file.Stat()
		if err != nil {
			return err
		}
		expectedInfo, err := os.Stat(expected[calls])
		if err != nil {
			return err
		}
		if !os.SameFile(actualInfo, expectedInfo) {
			t.Fatalf("flush %d used another directory", calls)
		}
		calls++
		return original(file)
	}
	if err := syncHomeChainFrom(home, ancestor, root); err != nil {
		t.Fatal(err)
	}
	if calls != len(expected) {
		t.Fatalf("flushes=%d want=%d", calls, len(expected))
	}
}

func TestExplicitRootBarrierEveryFlushIsRequired(t *testing.T) {
	for failAt := 1; failAt <= 8; failAt++ {
		t.Run(string(rune('0'+failAt)), func(t *testing.T) {
			ancestor, home, root := explicitRootFixture(t)
			original := strictSync
			t.Cleanup(func() { strictSync = original })
			injected := errors.New("required directory flush failed")
			calls := 0
			strictSync = func(file *os.File) error {
				calls++
				if calls == failAt {
					return injected
				}
				return original(file)
			}
			if err := syncHomeChainFrom(home, ancestor, root); !errors.Is(err, injected) || calls != failAt {
				t.Fatalf("err=%v calls=%d want=%d", err, calls, failAt)
			}
		})
	}
}

func TestExplicitRootBarrierRejectsInvalidBoundary(t *testing.T) {
	for _, fixture := range []string{"sibling", "descendant", "relative", "pinned-other-home"} {
		t.Run(fixture, func(t *testing.T) {
			ancestor, home, root := explicitRootFixture(t)
			boundary := ancestor
			switch fixture {
			case "sibling":
				boundary = filepath.Join(ancestor, "other")
				if err := os.Mkdir(boundary, 0700); err != nil {
					t.Fatal(err)
				}
			case "descendant":
				boundary = filepath.Join(home, "notes")
				if err := os.Mkdir(boundary, 0700); err != nil {
					t.Fatal(err)
				}
			case "relative":
				boundary = "homes"
			case "pinned-other-home":
				other := filepath.Join(ancestor, "other")
				if err := os.Mkdir(other, 0700); err != nil {
					t.Fatal(err)
				}
				var err error
				root, err = os.OpenRoot(other)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = root.Close() })
			}
			if err := syncHomeChainFrom(home, boundary, root); err == nil {
				t.Fatal("invalid chain was admitted")
			}
		})
	}
}

func TestExplicitRootBarrierSupportsHomeAsBoundary(t *testing.T) {
	_, home, root := explicitRootFixture(t)
	if err := syncHomeChainFrom(home, home, root); err != nil {
		t.Fatal(err)
	}
}
