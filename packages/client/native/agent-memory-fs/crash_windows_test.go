//go:build windows

package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// #522 model P on real NTFS. A child process runs the real helper replace and
// delete in the order of agent-memory-intent.ts: durable applying, memory CAS,
// durable terminal, Host complete, durable ackedAt. The parent is the Host. It
// kills the child with TerminateProcess and then reads the store from disk.
// The ledger here holds one record, not the real record list. A process kill
// keeps the OS cache, so these tests prove nothing about OS crash or power
// loss.
const (
	crashPrefix     = "CRASHPROBE"
	crashHomeEnv    = "BYOK_TEST_CRASH_HOME"
	crashLastEnv    = "BYOK_TEST_CRASH_LAST"
	crashBlockEnv   = "BYOK_TEST_CRASH_BLOCK"
	crashMemoryPath = "notes/a.md"
	crashLedgerPath = ".byok/agent-memory-intents-v1.json"
)

var crashSteps = []string{"ledger-applying", "memory-cas", "ledger-applied", "host-complete", "ledger-acked"}

type crashRecord struct {
	Intent  int    `json:"intent"`
	Phase   string `json:"phase"`
	Base    string `json:"base"`
	Target  string `json:"target"`
	Padding string `json:"padding"`
}

// Large, distinct versions make a torn or mixed write visible as a hash miss.
func crashMemory(intent int) []byte {
	return []byte(strings.Repeat(fmt.Sprintf("intent %06d memory line\n", intent), 4000))
}

func crashLedger(intent int, phase, base, target string) []byte {
	encoded, err := json.Marshal(crashRecord{Intent: intent, Phase: phase, Base: base, Target: target, Padding: strings.Repeat(fmt.Sprintf("%06d", intent), 4000)})
	if err != nil {
		panic(err)
	}
	return encoded
}

type crashProbe struct {
	intent, step         int
	count                int
	blockIntent, blockAt int
}

// event stops the child forever at the chosen barrier point so the parent can
// kill it there. The child never resumes from a blocked point.
func (p *crashProbe) event(stage string) {
	if p.intent == p.blockIntent && p.count == p.blockAt {
		fmt.Printf("%s at %d %d %s %s\n", crashPrefix, p.intent, p.count, crashSteps[p.step], stage)
		time.Sleep(time.Hour)
	}
	p.count++
}

func TestWindowsCrashProbeChild(t *testing.T) {
	home := os.Getenv(crashHomeEnv)
	if home == "" {
		t.Skip("child process for the Windows process-kill tests")
	}
	if err := runCrashChild(home); err != nil {
		fmt.Printf("%s error %v\n", crashPrefix, err)
		os.Exit(3)
	}
}

// crashHomeIdentity reads the identity from a separate handle, as the TS
// caller does before it sends open.
func crashHomeIdentity(home string) (rootIdentity, error) {
	root, err := os.OpenRoot(home)
	if err != nil {
		return rootIdentity{}, err
	}
	defer root.Close()
	return identityForRoot(root, nil)
}

func runCrashChild(home string) error {
	last, err := strconv.Atoi(os.Getenv(crashLastEnv))
	if err != nil {
		return err
	}
	probe := &crashProbe{intent: -1, blockIntent: -2}
	if block := os.Getenv(crashBlockEnv); block != "" {
		if _, err := fmt.Sscanf(block, "%d:%d", &probe.blockIntent, &probe.blockAt); err != nil {
			return err
		}
	}
	identity, err := crashHomeIdentity(home)
	if err != nil {
		return err
	}
	active, failure := openSession(openRequest{ID: "open", Protocol: protocolVersion, Op: "open", Root: home, ExpectedIdentity: identity})
	if failure != nil {
		return failure
	}
	defer active.root.Close()
	original := strictSync
	strictSync = func(file *os.File) error {
		kind := "file"
		if info, err := file.Stat(); err == nil && info.IsDir() {
			kind = "dir"
		}
		probe.event("before-" + kind + "-sync")
		syncErr := original(file)
		probe.event("after-" + kind + "-sync")
		return syncErr
	}
	beforeFinalCAS = func() { probe.event("before-final-cas") }

	next, err := recoverCrashStore(active)
	if err != nil {
		return err
	}
	fmt.Printf("%s ready %d\n", crashPrefix, next)
	for intent := next; last < 0 || intent <= last; intent++ {
		if err := runCrashIntent(active, probe, intent); err != nil {
			return fmt.Errorf("intent %d step %s: %w", intent, crashSteps[probe.step], err)
		}
	}
	fmt.Printf("%s done\n", crashPrefix)
	return nil
}

func crashRead(active *session, path string) (fileState, error) {
	state, failure := active.read(readRequest{ID: "read", Protocol: protocolVersion, Op: "read", Path: path, MaxBytes: maxLocalLogBytes})
	if failure != nil {
		return fileState{}, failure
	}
	return state, nil
}

func crashReplace(active *session, path, base string, content []byte) (string, error) {
	state, failure := active.replace(replaceRequest{ID: "replace", Protocol: protocolVersion, Op: "replace", Path: path,
		ExpectedRevision: base, ContentBase64: base64.RawStdEncoding.EncodeToString(content), MaxBytes: maxLocalLogBytes})
	if failure != nil {
		return "", failure
	}
	return state.Revision, nil
}

// recoverCrashStore follows settleExistingRow: applying becomes uncertain with
// no second CAS. A terminal is rewritten before it is completed again.
func recoverCrashStore(active *session) (int, error) {
	ledger, err := crashRead(active, crashLedgerPath)
	if err != nil || !ledger.Exists {
		return 0, err
	}
	raw, err := base64.RawStdEncoding.DecodeString(ledger.ContentBase64)
	if err != nil {
		return 0, err
	}
	var record crashRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return 0, err
	}
	fmt.Printf("%s recovered %d %s\n", crashPrefix, record.Intent, record.Phase)
	switch record.Phase {
	case "applying":
		_, err = crashReplace(active, crashLedgerPath, ledger.Revision, crashLedger(record.Intent, "uncertain", record.Base, record.Target))
	case "applied":
		revision, rewriteErr := crashReplace(active, crashLedgerPath, ledger.Revision, raw)
		if rewriteErr != nil {
			return 0, rewriteErr
		}
		fmt.Printf("%s applied %d %s\n", crashPrefix, record.Intent, record.Target)
		_, err = crashReplace(active, crashLedgerPath, revision, crashLedger(record.Intent, "acked", record.Base, record.Target))
	}
	return record.Intent + 1, err
}

func runCrashIntent(active *session, probe *crashProbe, intent int) error {
	probe.intent, probe.step, probe.count = intent, 0, 0
	ledger, err := crashRead(active, crashLedgerPath)
	if err != nil {
		return err
	}
	memory, err := crashRead(active, crashMemoryPath)
	if err != nil {
		return err
	}
	content := crashMemory(intent)
	target := stateForBytes(content).Revision
	remove := memory.Exists && intent%3 == 2
	if remove {
		target = emptyFileState().Revision
	}
	revision, err := crashReplace(active, crashLedgerPath, ledger.Revision, crashLedger(intent, "applying", memory.Revision, target))
	if err != nil {
		return err
	}
	probe.step = 1
	if remove {
		if _, failure := active.delete(deleteRequest{ID: "delete", Protocol: protocolVersion, Op: "delete", Path: crashMemoryPath, ExpectedRevision: memory.Revision}); failure != nil {
			return failure
		}
	} else if _, err := crashReplace(active, crashMemoryPath, memory.Revision, content); err != nil {
		return err
	}
	probe.step = 2
	if revision, err = crashReplace(active, crashLedgerPath, revision, crashLedger(intent, "applied", memory.Revision, target)); err != nil {
		return err
	}
	probe.step = 3
	fmt.Printf("%s applied %d %s\n", crashPrefix, intent, target)
	probe.event("after-send")
	probe.step = 4
	_, err = crashReplace(active, crashLedgerPath, revision, crashLedger(intent, "acked", memory.Revision, target))
	return err
}

// crashHost is the parent: it keeps every applied completion it received.
type crashHost struct {
	t       *testing.T
	home    string
	applied map[int]string
	last    *crashRecord
}

func newCrashHost(t *testing.T) *crashHost {
	t.Helper()
	home := t.TempDir()
	for _, directory := range []string{"notes", ".byok"} {
		if err := os.Mkdir(filepath.Join(home, directory), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		t.Fatal(err)
	}
	requireNTFS(t, root)
	if err := root.Close(); err != nil {
		t.Fatal(err)
	}
	return &crashHost{t: t, home: home, applied: map[int]string{}}
}

type crashRun struct {
	lines  []string
	times  []time.Duration
	output []string
	killed bool
}

// run starts one child. It kills the child at the first line for which
// killOnLine is true, or killDelay after the start when killDelay > 0. All
// lines are read until the pipe closes, so a completion written just before
// the kill still counts as received by the Host.
func (h *crashHost) run(last int, block string, killOnLine func(line string) bool, killDelay time.Duration) crashRun {
	h.t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestWindowsCrashProbeChild$", "-test.count=1")
	command.Env = append(os.Environ(), crashHomeEnv+"="+h.home, crashLastEnv+"="+strconv.Itoa(last), crashBlockEnv+"="+block)
	stdout, err := command.StdoutPipe()
	if err != nil {
		h.t.Fatal(err)
	}
	command.Stderr = command.Stdout
	started := time.Now()
	if err := command.Start(); err != nil {
		h.t.Fatal(err)
	}
	// A failed check must not leave a blocked child holding the home.
	defer func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	var killed atomic.Bool
	var killErr error
	var once sync.Once
	// os.Process.Kill is TerminateProcess on Windows.
	kill := func() { once.Do(func() { killed.Store(true); killErr = command.Process.Kill() }) }
	if killDelay > 0 {
		timer := time.AfterFunc(killDelay, kill)
		defer timer.Stop()
	}
	var result crashRun
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		result.output = append(result.output, line)
		if !strings.HasPrefix(line, crashPrefix+" ") {
			continue
		}
		line = strings.TrimPrefix(line, crashPrefix+" ")
		result.lines = append(result.lines, line)
		result.times = append(result.times, time.Since(started))
		var intent int
		var target string
		if _, err := fmt.Sscanf(line, "applied %d %s", &intent, &target); err == nil {
			h.applied[intent] = target
		}
		if strings.HasPrefix(line, "error ") {
			h.t.Fatalf("child failed: %s", line)
		}
		if killOnLine != nil && killOnLine(line) {
			kill()
		}
	}
	if err := scanner.Err(); err != nil {
		h.t.Fatal(err)
	}
	waitErr := command.Wait()
	once.Do(func() {})
	result.killed = killed.Load()
	if killErr != nil {
		h.t.Fatal(killErr)
	}
	if !result.killed && waitErr != nil {
		h.t.Fatalf("child exited without a kill: %v output=%q", waitErr, result.output)
	}
	return result
}

type crashState struct {
	record       *crashRecord
	memoryExists bool
	memory       string
	leftovers    int
}

// observe reads the store as a restarted process sees it and checks the
// invariants that every kill point must keep.
func (h *crashHost) observe() crashState {
	h.t.Helper()
	var state crashState
	raw, err := os.ReadFile(filepath.Join(h.home, filepath.FromSlash(crashLedgerPath)))
	if err == nil {
		var record crashRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			h.t.Fatalf("torn ledger (%d bytes): %v", len(raw), err)
		}
		if !bytes.Equal(raw, crashLedger(record.Intent, record.Phase, record.Base, record.Target)) {
			h.t.Fatalf("ledger is not one complete version: intent=%d phase=%s bytes=%d", record.Intent, record.Phase, len(raw))
		}
		state.record = &record
	} else if !errors.Is(err, fs.ErrNotExist) {
		h.t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(h.home, filepath.FromSlash(crashMemoryPath)))
	if err == nil {
		if len(content) == 0 {
			h.t.Fatal("memory file exists but is empty")
		}
		state.memoryExists = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		h.t.Fatal(err)
	}
	state.memory = stateForBytes(content).Revision
	for _, directory := range []string{"notes", ".byok"} {
		entries, err := os.ReadDir(filepath.Join(h.home, directory))
		if err != nil {
			h.t.Fatal(err)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".byok-agent-memory-") {
				state.leftovers++
			}
		}
	}

	record := state.record
	if record == nil {
		if state.memoryExists || len(h.applied) != 0 {
			h.t.Fatalf("no ledger, but memory=%v applied=%v", state.memoryExists, h.applied)
		}
		return state
	}
	want := stateForBytes(crashMemory(record.Intent)).Revision
	if record.Target != want && !(record.Intent%3 == 2 && record.Target == emptyFileState().Revision) {
		h.t.Fatalf("ledger target %s is not a complete version of intent %d", record.Target, record.Intent)
	}
	switch record.Phase {
	case "applying", "uncertain":
		if state.memory != record.Base && state.memory != record.Target {
			h.t.Fatalf("%s intent %d: memory %s is neither base nor target", record.Phase, record.Intent, state.memory)
		}
	case "applied", "acked":
		if state.memory != record.Target {
			h.t.Fatalf("%s intent %d: memory %s, want target %s", record.Phase, record.Intent, state.memory, record.Target)
		}
	default:
		h.t.Fatalf("unknown phase %q", record.Phase)
	}
	// #522: the Host has a completion, so the device must not roll back
	// before that terminal.
	latest := -1
	for intent := range h.applied {
		latest = max(latest, intent)
	}
	if record.Intent < latest || (record.Intent == latest && record.Phase != "applied" && record.Phase != "acked") {
		h.t.Fatalf("Host holds applied intent %d, device ledger is intent %d %s", latest, record.Intent, record.Phase)
	}
	if target, ok := h.applied[record.Intent]; ok && target != record.Target {
		h.t.Fatalf("Host target %s, device target %s", target, record.Target)
	}
	if h.last != nil && (record.Intent < h.last.Intent || (record.Intent == h.last.Intent && crashPhaseRank(record.Phase) < crashPhaseRank(h.last.Phase))) {
		h.t.Fatalf("ledger rolled back from %d %s to %d %s", h.last.Intent, h.last.Phase, record.Intent, record.Phase)
	}
	h.last = record
	return state
}

func crashPhaseRank(phase string) int {
	switch phase {
	case "applying":
		return 0
	case "applied", "uncertain":
		return 1
	}
	return 2
}

// Each barrier point of one intent: replace-new, replace-existing and delete.
// Before the rename of a step, the step's file must be old. After it, new.
func TestWindowsProcessKillAtEachBarrierPointOnNTFS(t *testing.T) {
	for _, target := range []struct {
		name   string
		intent int
	}{{"replace-new", 0}, {"replace-existing", 1}, {"delete", 2}} {
		t.Run(target.name, func(t *testing.T) {
			points := 0
			for point := 0; ; point++ {
				host := newCrashHost(t)
				var step, stage string
				run := host.run(target.intent, fmt.Sprintf("%d:%d", target.intent, point), func(line string) bool {
					var intent, count int
					_, err := fmt.Sscanf(line, "at %d %d %s %s", &intent, &count, &step, &stage)
					return err == nil
				}, 0)
				if !run.killed {
					if len(run.lines) == 0 || run.lines[len(run.lines)-1] != "done" {
						t.Fatalf("child stopped early: %q", run.output)
					}
					break
				}
				points++
				state := host.observe()
				checkCrashPoint(t, host, target.intent, step, stage, state)

				ledger, settledLedger := "none", "none"
				if state.record != nil {
					ledger = fmt.Sprintf("%d %s", state.record.Intent, state.record.Phase)
					settledLedger = checkCrashRecoveryOnly(t, host, state)
				}
				recovery := host.run(target.intent+1, "", nil, 0)
				final := host.observe()
				if final.record == nil || final.record.Intent != target.intent+1 || final.record.Phase != "acked" {
					t.Fatalf("recovery after %s/%s did not finish: %+v lines=%q", step, stage, final.record, recovery.lines)
				}
				if state.record != nil && recovery.lines[0] != "recovered "+settledLedger {
					t.Fatalf("recovery did not start from the settled record %s: %q", settledLedger, recovery.lines)
				}
				t.Logf("OBSERVED kill at %s/%s: ledger=%s settled=%s memoryExists=%v leftovers=%d recovery=%q",
					step, stage, ledger, settledLedger, state.memoryExists, state.leftovers, recovery.lines)
			}
			// Four helper writes with five points each, and one point after the
			// Host send. A delete has no temp file but two directory barriers.
			if points != 21 {
				t.Fatalf("%d barrier points, want 21", points)
			}
			t.Logf("OBSERVED %d kill points for %s", points, target.name)
		})
	}
}

// checkCrashRecoveryOnly runs one child that only recovers. Recovery must
// settle the killed record and must not write memory: applying becomes
// uncertain with no second CAS, and a terminal is completed again.
func checkCrashRecoveryOnly(t *testing.T, host *crashHost, killed crashState) string {
	t.Helper()
	run := host.run(killed.record.Intent, "", nil, 0)
	want := map[string]string{"applying": "uncertain", "applied": "acked", "acked": "acked", "uncertain": "uncertain"}[killed.record.Phase]
	settled := host.observe()
	if settled.record.Intent != killed.record.Intent || settled.record.Phase != want {
		t.Fatalf("recovery settled %d %s to %d %s, want %s: %q", killed.record.Intent, killed.record.Phase, settled.record.Intent, settled.record.Phase, want, run.lines)
	}
	if settled.memoryExists != killed.memoryExists || settled.memory != killed.memory {
		t.Fatalf("recovery of %d %s wrote memory: %s -> %s", killed.record.Intent, killed.record.Phase, killed.memory, settled.memory)
	}
	return fmt.Sprintf("%d %s", settled.record.Intent, settled.record.Phase)
}

func checkCrashPoint(t *testing.T, host *crashHost, intent int, step, stage string, state crashState) {
	t.Helper()
	index := -1
	for candidate, name := range crashSteps {
		if name == step {
			index = candidate
		}
	}
	// Only the namespace barrier after a rename syncs a directory.
	position := index * 2
	if strings.Contains(stage, "dir-sync") || step == "host-complete" {
		position++
	}
	record := state.record
	if position > 0 && record == nil {
		t.Fatalf("%s/%s: no ledger after the applying rename", step, stage)
	}
	switch {
	case position == 0:
		if intent == 0 {
			if record != nil {
				t.Fatalf("%s/%s: ledger exists before the first rename", step, stage)
			}
		} else if record.Intent != intent-1 || record.Phase != "acked" {
			t.Fatalf("%s/%s: ledger %d %s, want previous acked", step, stage, record.Intent, record.Phase)
		}
		return
	case position <= 4:
		if record.Intent != intent || record.Phase != "applying" {
			t.Fatalf("%s/%s: ledger %d %s, want applying", step, stage, record.Intent, record.Phase)
		}
	case position <= 8:
		if record.Intent != intent || record.Phase != "applied" {
			t.Fatalf("%s/%s: ledger %d %s, want applied", step, stage, record.Intent, record.Phase)
		}
	default:
		if record.Intent != intent || record.Phase != "acked" {
			t.Fatalf("%s/%s: ledger %d %s, want acked", step, stage, record.Intent, record.Phase)
		}
	}
	wantNew := position >= 3
	if got := state.memory == record.Target; got != wantNew {
		t.Fatalf("%s/%s: memory is target=%v, want %v", step, stage, got, wantNew)
	}
	if _, sent := host.applied[intent]; sent != (position >= 7) {
		t.Fatalf("%s/%s: Host complete received=%v", step, stage, sent)
	}
}

// Kills at random times in a long run. A run with no kill first measures the
// start-up time and the time per intent. Each delay then falls in start-up,
// recovery or the next few intents.
func TestWindowsProcessKillAtRandomTimesOnNTFS(t *testing.T) {
	host := newCrashHost(t)
	calibration := host.run(4, "", nil, 0)
	if calibration.lines[0] != "ready 0" || calibration.lines[len(calibration.lines)-1] != "done" {
		t.Fatalf("calibration run failed: %q", calibration.output)
	}
	startup := calibration.times[0]
	perIntent := (calibration.times[len(calibration.times)-1] - startup) / 5
	host.observe()

	phases := map[string]int{}
	beforeReady := 0
	const rounds = 150
	for round := 0; round < rounds; round++ {
		run := host.run(-1, "", nil, time.Millisecond+rand.N(startup+3*perIntent))
		if !run.killed {
			t.Fatalf("round %d: child was not killed: %q", round, run.output)
		}
		if !slices.ContainsFunc(run.lines, func(line string) bool { return strings.HasPrefix(line, "ready ") }) {
			beforeReady++
		}
		phases[host.observe().record.Phase]++
	}
	final := host.last
	if final.Intent <= 4 {
		t.Fatalf("killed children made no progress: ledger=%d %s", final.Intent, final.Phase)
	}
	// Most kills must land after start-up, and in each ledger phase.
	if beforeReady >= rounds/2 || phases["applying"] == 0 || phases["applied"] == 0 || phases["acked"] == 0 {
		t.Fatalf("random kills missed the intent windows: beforeReady=%d phases=%v", beforeReady, phases)
	}
	t.Logf("OBSERVED %d random kills: startup=%v perIntent=%v beforeReady=%d phases=%v final ledger=%d %s applied=%d",
		rounds, startup, perIntent, beforeReady, phases, final.Intent, final.Phase, len(host.applied))
}
