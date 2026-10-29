package main

import (
	"os"
	"strings"
)

func isHelperTemporary(name string) bool {
	for _, kind := range []string{"replace", "delete"} {
		value, found := strings.CutPrefix(name, ".byok-agent-memory-"+kind+"-")
		if !found || len(value) != 36 || !strings.HasSuffix(value, ".tmp") {
			continue
		}
		for _, digit := range value[:32] {
			if !(digit >= '0' && digit <= '9' || digit >= 'a' && digit <= 'f') {
				return false
			}
		}
		return true
	}
	return false
}

// Mutators run under the caller's exclusive home lease. Reclaim only the
// helper's reserved leaf names in the pinned parent being written, never a
// recursive sweep or a content-based recovery of an interrupted write.
func (p *pinnedDirectory) cleanupTemporaries() *protocolError {
	directory, err := p.root.Open(".")
	if err != nil {
		return failure("io_failure", "filesystem operation failed")
	}
	entries, readErr := directory.ReadDir(-1)
	closeErr := directory.Close()
	if readErr != nil || closeErr != nil {
		return failure("io_failure", "filesystem operation failed")
	}
	removed := false
	for _, entry := range entries {
		if !isHelperTemporary(entry.Name()) {
			continue
		}
		file, _, exists, leafErr := p.openSingleLink(entry.Name(), os.O_RDONLY)
		if leafErr != nil {
			return leafErr
		}
		if !exists {
			return failure("unsafe_path", "temporary file changed")
		}
		if err := file.Close(); err != nil {
			return failure("io_failure", "filesystem operation failed")
		}
		if err := p.root.Remove(entry.Name()); err != nil {
			return failure("io_failure", "filesystem operation failed")
		}
		removed = true
	}
	if removed {
		if err := p.sync(); err != nil {
			return failure("io_failure", "temporary cleanup barrier failed")
		}
	}
	return nil
}
