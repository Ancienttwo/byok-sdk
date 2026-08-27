//go:build !windows

package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v2 persists its redacted outbox and metadata-only audit through replace(),
// with AGENT_MEMORY_MAX_LOCAL_LOG_BYTES as the bounded internal-state limit.
// The helper must carry that bounded payload over its JSON-lines protocol; it
// must not apply the 256 KiB user-memory-file cap to SDK internal state.
func TestRound2P1ReplaceCarriesBoundedInternalStateOverStdio(t *testing.T) {
	home := newMemoryHome(t)
	if err := os.Mkdir(filepath.Join(home, ".byok"), 0o700); err != nil {
		t.Fatal(err)
	}

	helper := startOpenedHelper(t, home)
	before := helper.read(".byok/agent-memory-outbox.json", maxLocalLogBytes)
	requireSuccess(t, before)
	var initial fileState
	decodeResult(t, before, &initial)

	content := strings.Repeat("x", maxLocalLogBytes)
	response := helper.request(map[string]any{
		"id":               helper.id("round2-internal-state"),
		"protocol":         protocolVersion,
		"op":               "replace",
		"path":             ".byok/agent-memory-outbox.json",
		"expectedRevision": initial.Revision,
		"contentBase64":    base64.RawStdEncoding.EncodeToString([]byte(content)),
		"maxBytes":         maxLocalLogBytes,
	})
	requireSuccess(t, response)

	var replaced fileState
	decodeResult(t, response, &replaced)
	if !replaced.Exists || replaced.ByteCount != maxLocalLogBytes {
		t.Fatalf("internal state replace = %#v", replaced)
	}

	overInternalLimit := helper.request(map[string]any{
		"id":               helper.id("round2-internal-state-over-limit"),
		"protocol":         protocolVersion,
		"op":               "replace",
		"path":             ".byok/agent-memory-audit-v1.jsonl",
		"expectedRevision": emptyFileState().Revision,
		"contentBase64":    base64.RawStdEncoding.EncodeToString([]byte(strings.Repeat("x", maxLocalLogBytes+1))),
		"maxBytes":         maxLocalLogBytes,
	})
	requireFailure(t, overInternalLimit, "invalid_request")

	userMemoryOverCap := helper.request(map[string]any{
		"id":               helper.id("round2-user-memory-over-limit"),
		"protocol":         protocolVersion,
		"op":               "replace",
		"path":             "MEMORY.md",
		"expectedRevision": emptyFileState().Revision,
		"contentBase64":    base64.RawStdEncoding.EncodeToString([]byte(strings.Repeat("x", maxFileBytes+1))),
		"maxBytes":         maxFileBytes,
	})
	requireFailure(t, userMemoryOverCap, "invalid_request")
	helper.close()
}
