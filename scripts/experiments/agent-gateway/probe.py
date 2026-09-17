"""Owned native sessions + actual SDK communication probe. Python 3.11+.

No product Gateway, no retry of native inputs, no model fallback. Raw native
logs and member leases remain in mode-0700 scratch; output is synthetic evidence.
Run --preflight before --live. Neither command changes global configuration.
"""
import argparse
import hashlib
import json
import os
import pathlib
import pty
import queue
import shutil
import signal
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import time
import tomllib
import uuid
import fcntl
import termios

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
OPS = ROOT / '_ops/agent-gateway'
FIX = HERE / 'fixture.ts'
BRIDGE = ROOT / 'docs/researches/evidence/2026-09-06-pi-relay/ws-bridge.ts'
ENDPOINT = 'https://api.z.ai/api/coding/paas/v4'
TOOLS = ['read_team_messages', 'post_team_message', 'ack_team_messages']


def require(ok, label):
    if not ok:
        raise RuntimeError(label)


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(args, **kw):
    r = subprocess.run(args, capture_output=True, text=True, timeout=25, **kw)
    require(r.returncode == 0, 'command_failed:' + pathlib.Path(args[0]).name)
    return r.stdout.strip()


def read_jsonl(p):
    if not p.exists():
        return []
    # A writer may have an incomplete final line; only complete records count.
    data = p.read_text()
    return [json.loads(s) for s in data.splitlines(keepends=True) if s.endswith('\n')]


def wait_for(predicate, label, seconds=180):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = predicate()
        if value:
            return value
        time.sleep(.1)
    raise TimeoutError(label)


def targets():
    bins = {n: shutil.which(n) for n in ['pi', 'codex', 'bun', 'node']}
    require(all(bins.values()), 'missing_native_binary')
    versions = {n: run([b, '--version']) for n, b in bins.items()}
    require(versions['pi'] == '0.85.1', 'pi_version_mismatch')
    require(versions['codex'] == 'codex-cli 0.154.0', 'codex_version_mismatch')
    native = pathlib.Path(bins['pi']).resolve().parents[2]
    require(json.loads((native / 'package.json').read_text())['name'] == '@earendil-works/pi-coding-agent', 'pi_package_root_mismatch')
    data = native / 'node_modules/@earendil-works/pi-ai/dist/providers/data/zai.json'
    model = json.loads(data.read_text())['openai-completions']['glm-5.3-flash']
    require(model['provider'] == 'zai' and model['baseUrl'] == ENDPOINT, 'coding_plan_mismatch')
    ambient = tomllib.loads((pathlib.Path.home() / '.codex/config.toml').read_text())
    require(ambient.get('model') == 'gpt-6-astra', 'codex_model_mismatch')
    pin = json.loads((OPS / 'upstream.json').read_text())
    require(sha(OPS / 'control.ts') == pin['sha256'], 'upstream_hash_mismatch')
    source = [HERE / n for n in ['fixture.ts', 'pi-observer.ts', 'probe.py', 'verify.py']]
    source += [BRIDGE, ROOT / 'bun.lock', ROOT / 'packages/client/package.json', ROOT / 'packages/core/package.json', OPS / 'control.ts']
    for package in ['client', 'core']:
        source.extend(sorted((ROOT / f'packages/{package}/src').rglob('*.ts')))
    require(all(p.is_file() for p in source), 'missing_probe_source')
    info = {'versions': versions, 'pi': {'provider': model['provider'], 'modelId': model['id'], 'baseUrl': model['baseUrl']},
            'codex': {'modelId': ambient['model'], 'effort': 'low'}, 'upstream': pin,
            'sourceSha256': {str(p.relative_to(ROOT)): sha(p) for p in source},
            'nativeSha256': {str(data): sha(data), str(pathlib.Path(bins['pi']).resolve()): sha(pathlib.Path(bins['pi']).resolve())}}
    return bins, ambient, info


class Probe:
    def __init__(self, bins):
        self.bins = bins
        self.scratch = pathlib.Path(tempfile.mkdtemp(prefix='byok-gateway-probe-', dir='/tmp'))
        self.scratch.chmod(0o700)
        self.processes = []
        self.streams = []
        self.pi = None
        self.pi_socket = None
        self.master = None
        self.native = None
        self.events = []
        self.native_inputs = []

    def start(self, args, label, env=None):
        err = open(self.scratch / (label + '.stderr.private'), 'w')
        self.streams.append(err)
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=err, text=True, cwd=self.scratch, env=env, start_new_session=True)
        self.processes.append(proc)
        return proc

    def stop(self, proc):
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)

    def fixture(self, mode):
        p = self.start([self.bins['bun'], str(FIX), mode, str(self.scratch)], 'fixture-' + mode)
        q = queue.Queue()
        threading.Thread(target=lambda: q.put(p.stdout.readline()), daemon=True).start()
        require(json.loads(q.get(timeout=20))['ready'], 'fixture_not_ready')
        return p

    def cli(self, mode, *args):
        return json.loads(run([self.bins['bun'], str(FIX), mode, str(self.scratch), *args], cwd=self.scratch))

    def start_pi(self):
        config = json.loads((self.scratch / 'bob/mcp.json').read_text())
        config['settings'] = {'hostConfigDiscovery': 'off', 'scriptMode': False, 'disableProxyTool': True}
        config['mcpServers']['byokagentteam'].update(lifecycle='eager', directTools=True, toolPrefix='none',
                                                    includeTools=TOOLS, exposeResources=False)
        config_path = self.scratch / 'bob/probe-mcp.json'
        config_path.write_text(json.dumps(config))
        agent_dir = self.scratch / 'pi-agent'
        agent_dir.mkdir(mode=0o700)
        (agent_dir / 'settings.json').write_text('{"quietStartup":true,"enablePromptCaching":false}')
        self.telemetry = self.scratch / 'pi-observer.jsonl'
        env = os.environ.copy()
        env.update(PI_CODING_AGENT_DIR=str(agent_dir), PI_OFFLINE='1', PI_TELEMETRY='0',
                   BYOK_PI_MCP_CONFIG_PATH=str(config_path), BYOK_GATEWAY_OBSERVER=str(self.telemetry), TERM='xterm-256color')
        # Read only the selected native credential, hold it only in child env.
        selected = json.loads((pathlib.Path.home() / '.pi/agent/auth.json').read_text())['zai']
        require(selected.get('type') == 'api_key' and isinstance(selected.get('key'), str), 'zai_auth_missing')
        env['ZAI_API_KEY'] = selected['key']
        del selected
        args = [self.bins['pi'], '--session-control', '--provider', 'zai', '--model', 'glm-5.3-flash',
                '--session-dir', str(self.scratch / 'pi-sessions'), '--no-extensions', '--no-context-files',
                '--no-skills', '--no-prompt-templates', '--no-themes', '--no-builtin-tools',
                '--exclude-tools', 'mcp,mcpScript,send_to_session,list_sessions', '--extension', str(OPS / 'control.ts'),
                '--extension', str(ROOT / 'packages/client/src/adapters/pi/mcp-extension.ts'),
                '--extension', str(HERE / 'pi-observer.ts'), '--system-prompt',
                'Synthetic communication probe. Use only read_team_messages, post_team_message and ack_team_messages. '
                'Perform the exact requestId-correlated instruction once. No files, shell, peer session tools or outside actions. '
                'Never resend a posted message. Stop after the requested ACK. Report tool failures honestly.']
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        self.pi = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, cwd=self.scratch / 'bob', env=env, start_new_session=True)
        self.processes.append(self.pi)
        env.pop('ZAI_API_KEY')
        os.close(slave)

        def reader():
            with open(self.scratch / 'pi-terminal.private', 'wb') as log:
                try:
                    while True:
                        data = os.read(self.master, 65536)
                        if not data:
                            break
                        log.write(data)
                        log.flush()
                        if b'\x1b[6n' in data:
                            os.write(self.master, b'\x1b[1;1R')
                except OSError:
                    pass
        threading.Thread(target=reader, daemon=True).start()
        start = wait_for(lambda: next((e for e in read_jsonl(self.telemetry) if e['event'] == 'session_start'), None), 'pi_session_start', 35)
        require(start['modelProvider'] == 'zai' and start['modelId'] == 'glm-5.3-flash' and start.get('baseUrl') == ENDPOINT, 'pi_effective_model_mismatch')
        self.pi_sid = start['sessionId']
        uuid.UUID(self.pi_sid)
        self.pi_socket = pathlib.Path.home() / '.pi/session-control' / (self.pi_sid + '.sock')
        wait_for(lambda: self.pi_socket.exists(), 'pi_socket_start', 10)
        return start

    def bind(self, expected):
        require(expected == self.pi_sid, 'wrong_expected_session')
        require(self.pi.poll() is None, 'owned_pi_not_alive')
        require(stat.S_ISSOCK(self.pi_socket.lstat().st_mode), 'not_socket')
        require(self.pi_socket.lstat().st_uid == os.getuid(), 'wrong_socket_owner')
        return self.pi_socket

    def pi_rpc(self, command, expected=None):
        target = self.bind(expected if expected is not None else self.pi_sid)
        rid = str(uuid.uuid4())
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(15)
            sock.connect(str(target))
            sock.sendall((json.dumps({**command, 'id': rid}) + '\n').encode())
            data = b''
            while b'\n' not in data:
                chunk = sock.recv(65536)
                require(bool(chunk), 'pi_rpc_closed_unknown_delivery')
                data += chunk
            reply = json.loads(data.split(b'\n')[0])
        require(reply.get('id') == rid and reply.get('success') is True, 'pi_rpc_rejected')
        return reply

    def cleanup(self):
        for p in reversed(self.processes):
            self.stop(p)
        if self.master is not None:
            os.close(self.master)
        # Remove only the exact socket of the owned exited Pi process if native
        # SIGTERM did not unlink it. Never scan aliases or touch other sessions.
        if self.pi_socket is not None and self.pi.poll() is not None and self.pi_socket.exists():
            require(stat.S_ISSOCK(self.pi_socket.lstat().st_mode), 'cleanup_not_owned_socket')
            self.pi_socket.unlink()
        for stream in self.streams:
            stream.close()
        return {'ownedProcessesStopped': all(p.poll() is not None for p in self.processes),
                'ownedPiSocketRemoved': self.pi_socket is None or not self.pi_socket.exists(),
                'privateScratch': str(self.scratch)}


class Native:
    def __init__(self, probe, ambient):
        self.probe = probe
        self.n = 0
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        self.endpoint = f'ws://127.0.0.1:{port}'
        args = [probe.bins['codex'], 'app-server', '--listen', self.endpoint]
        for name in ambient.get('mcp_servers', {}):
            require(name and all(c.isascii() and (c.isalnum() or c in '_-') for c in name), 'unsupported_mcp_config_key')
            args += ['-c', f'mcp_servers.{name}.enabled=false']
        overrides = {'notify': [], 'features.hooks': False, 'features.shell_tool': False, 'features.multi_agent': False,
                     'features.apps': False, 'features.plugins': False, 'features.code_mode': False, 'features.browser_use': False,
                     'features.computer_use': False, 'project_doc_max_bytes': 0, 'model': 'gpt-6-astra', 'model_reasoning_effort': 'low',
                     'mcp_servers.byokagentteam.enabled': True, 'mcp_servers.byokagentteam.command': probe.bins['bun'],
                     'mcp_servers.byokagentteam.args': [str(FIX), 'helper', str(probe.scratch), 'alice']}
        for name in TOOLS:
            overrides[f'mcp_servers.byokagentteam.tools.{name}.approval_mode'] = 'approve'
        for key, value in overrides.items():
            args += ['-c', key + '=' + json.dumps(value)]
        self.server = probe.start(args, 'codex-server')
        def listening():
            require(self.server.poll() is None, 'codex_server_exited')
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.2):
                    return True
            except OSError:
                return False
        wait_for(listening, 'codex_listen', 20)
        self.connect('initial')
        started = self.rpc('thread/start', {'cwd': str(probe.scratch / 'alice'), 'model': 'gpt-6-astra',
                           'ephemeral': False, 'approvalPolicy': 'on-request',
                           'baseInstructions': 'Synthetic communication probe. Use only byokagentteam read/post/ack MCP tools. '
                           'Execute exactly the requestId-correlated instruction once. No files, shell or outside actions. Never resend a posted message.'})
        self.sid = started['thread']['id']
        probe.native = self
        require(started['model'] == 'gpt-6-astra', 'codex_effective_model_mismatch')
        uuid.UUID(self.sid)

    def connect(self, label):
        self.bridge = self.probe.start([self.probe.bins['bun'], str(BRIDGE), self.endpoint], 'codex-bridge-' + label)
        self.q = queue.Queue()
        def reader(stream, q):
            with open(self.probe.scratch / ('codex-' + label + '.private.jsonl'), 'w') as log:
                for line in stream:
                    log.write(line)
                    log.flush()
                    event = json.loads(line)
                    self.probe.events.append(event)
                    q.put(event)
        threading.Thread(target=reader, args=(self.bridge.stdout, self.q), daemon=True).start()
        self.rpc('initialize', {'clientInfo': {'name': 'byok_gateway_probe', 'version': '1'}, 'capabilities': {'experimentalApi': True}})
        self.send({'method': 'initialized'})

    def send(self, body):
        self.bridge.stdin.write(json.dumps(body) + '\n')
        self.bridge.stdin.flush()

    def rpc(self, method, params):
        self.n += 1
        rid = self.n
        self.send({'id': rid, 'method': method, 'params': params})
        until = time.monotonic() + 30
        while time.monotonic() < until:
            try:
                e = self.q.get(timeout=.1)
            except queue.Empty:
                require(self.bridge.poll() is None, 'codex_bridge_exited')
                continue
            if e.get('id') == rid and 'method' not in e:
                require('error' not in e, 'codex_rpc_failed:' + method)
                return e['result']
        raise TimeoutError('codex_rpc:' + method)

    def queue_input(self, expected_sid, text):
        require(expected_sid == self.sid, 'wrong_codex_thread')
        return run([self.probe.bins['codex'], 'queue', '--remote', self.endpoint, '--thread', self.sid, '--message', text], cwd=self.probe.scratch)


def correlate(messages, request_id):
    require(len(messages) == 3, 'message_count')
    bodies = [json.loads(m['body']) for m in messages]
    require([m['seq'] for m in messages] == [1, 2, 3], 'sequence_mismatch')
    require([m['senderMemberId'] for m in messages] == ['alice', 'bob', 'alice'], 'sender_mismatch')
    require(all(b['requestId'] == request_id for b in bodies), 'wrong_request_correlation')
    require([b['kind'] for b in bodies] == ['request', 'reply', 'acknowledgement'], 'kind_mismatch')
    require(bodies[1]['replyTo'] == messages[0]['messageId'] and bodies[1]['answer'] == 'blue', 'pi_reply_mismatch')
    require(bodies[2]['replyTo'] == messages[1]['messageId'] and bodies[2]['accepted'] is True, 'codex_reply_mismatch')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--preflight', action='store_true')
    args = parser.parse_args()
    require(args.live != args.preflight, 'choose_preflight_or_live')
    os.umask(0o077)
    bins, ambient, target = targets()
    if args.preflight:
        print(json.dumps({'status': 'PREFLIGHT_PASS', 'versions': target['versions'], 'pi': target['pi'], 'codex': target['codex']}))
        return
    require(not (OPS / 'result.json').exists(), 'result_exists_no_implicit_rerun')
    probe = Probe(bins)
    result = {'schema': 1, 'status': 'FAIL', 'target': target, 'requestId': str(uuid.uuid4()), 'nativeInputs': probe.native_inputs}
    try:
        fixture = probe.fixture('start')
        pi_start = probe.start_pi()
        require(probe.pi_rpc({'type': 'get_message'})['data']['message'] is None, 'pi_session_not_fresh')
        result['piStart'] = pi_start
        result['negative'] = {}
        try:
            probe.pi_rpc({'type': 'get_message'}, str(uuid.uuid4()))
        except RuntimeError as e:
            require(str(e) == 'wrong_expected_session', 'unexpected_binding_error')
            result['negative']['wrongPiSessionRejectedBeforeConnect'] = True
        require(result['negative'].get('wrongPiSessionRejectedBeforeConnect'), 'wrong_session_accepted')
        with socket.socket(socket.AF_UNIX) as missing:
            try:
                missing.connect(str(probe.scratch / 'missing.sock'))
            except FileNotFoundError:
                result['negative']['missingSocketRefused'] = True
        require(result['negative'].get('missingSocketRefused'), 'missing_socket_accepted')
        # Codex thread exists before any Gateway notification is sent.
        native = Native(probe, ambient)
        probe.native = native
        result['codexSessionId'] = native.sid
        try:
            native.queue_input(str(uuid.uuid4()), 'must not send')
        except RuntimeError as e:
            require(str(e) == 'wrong_codex_thread', 'unexpected_codex_binding_error')
            result['negative']['wrongCodexSessionRejectedBeforeQueue'] = True
        request_id = result['requestId']
        seed = probe.cli('seed', 'alice', json.dumps({'kind': 'request', 'requestId': request_id, 'question': 'Name the fixed probe color blue.'}))
        result['seed'] = seed
        pi_body = {'kind': 'reply', 'requestId': request_id, 'replyTo': seed['messageId'], 'answer': 'blue'}
        prompt = (f'Call read_team_messages with afterSeq 0. Confirm exact requestId {request_id} and messageId {seed["messageId"]}. '
                  f'Only after finding it, call post_team_message once with body equal to this JSON string: {json.dumps(pi_body)}. '
                  'Then read_team_messages afterSeq 0 again and ack_team_messages with throughSeq exactly its deliveredThroughSeq. Finish with DONE.')
        probe.native_inputs.append({'harness': 'pi', 'sessionId': probe.pi_sid, 'requestId': request_id})
        result['piInputAcceptance'] = probe.pi_rpc({'type': 'send', 'message': prompt, 'mode': 'follow_up'})
        # pi_rpc closes its connection immediately after input acceptance; no resend.
        wait_for(lambda: any(e['event'] == 'agent_settled' for e in read_jsonl(probe.telemetry)), 'pi_settled')
        pi_state = probe.cli('inspect')
        require(len(pi_state['messages']) == 2, 'pi_durable_reply_missing')
        pi_reply = pi_state['messages'][1]
        require(json.loads(pi_reply['body']) == pi_body and pi_reply['senderMemberId'] == 'bob', 'pi_durable_reply_wrong')
        result['afterPi'] = pi_state
        codex_body = {'kind': 'acknowledgement', 'requestId': request_id, 'replyTo': pi_reply['messageId'], 'accepted': True}
        prompt = (f'Call read_team_messages with afterSeq 0. Confirm exact requestId {request_id} in Bob reply messageId {pi_reply["messageId"]}. '
                  f'Only after finding it, call post_team_message once with body equal to this JSON string: {json.dumps(codex_body)}. '
                  'Then read_team_messages afterSeq 0 again and ack_team_messages with throughSeq exactly its deliveredThroughSeq. Finish with DONE.')
        watermark = len(probe.events)
        probe.native_inputs.append({'harness': 'codex', 'sessionId': native.sid, 'requestId': request_id})
        result['codexQueueAcceptance'] = native.queue_input(native.sid, prompt)
        completed = wait_for(lambda: next((e for e in probe.events[watermark:] if e.get('method') == 'turn/completed' and e['params']['threadId'] == native.sid), None), 'codex_turn_completed')
        require(completed['params']['turn']['status'] == 'completed', 'codex_turn_failed')
        result['codexTurn'] = {'id': completed['params']['turn']['id'], 'status': completed['params']['turn']['status']}
        before = probe.cli('inspect')
        correlate(before['messages'], request_id)
        try:
            correlate(before['messages'], str(uuid.uuid4()))
        except RuntimeError as e:
            require(str(e) == 'wrong_request_correlation', 'unexpected_correlation_error')
            result['negative']['wrongRequestRejected'] = True
        result['beforeRecovery'] = before
        settled_before = len([e for e in read_jsonl(probe.telemetry) if e['event'] == 'agent_settled'])
        codex_before = native.rpc('thread/read', {'threadId': native.sid, 'includeTurns': True})['thread']
        pi_message_before = probe.pi_rpc({'type': 'get_message'})['data']
        # Reopen actual SDK control + store, retaining the original native processes.
        probe.stop(fixture)
        probe.stop(native.bridge)
        fixture = probe.fixture('restart')
        native.connect('reconnected')
        codex_after = native.rpc('thread/read', {'threadId': native.sid, 'includeTurns': True})['thread']
        pi_message_after = probe.pi_rpc({'type': 'get_message'})['data']
        after = probe.cli('inspect')
        result['afterRecovery'] = after
        result['recovery'] = {'piSessionId': probe.bind(probe.pi_sid).stem, 'codexSessionId': codex_after['id'],
                              'piMessageUnchanged': pi_message_before == pi_message_after,
                              'codexTurnIdsBefore': [t['id'] for t in codex_before['turns']],
                              'codexTurnIdsAfter': [t['id'] for t in codex_after['turns']],
                              'piSettledBefore': settled_before,
                              'piSettledAfter': len([e for e in read_jsonl(probe.telemetry) if e['event'] == 'agent_settled']),
                              'storeUnchanged': before == after, 'unknownDeliveryResends': 0}
        require(before == after, 'recovery_store_changed')
        require(result['recovery']['codexTurnIdsBefore'] == result['recovery']['codexTurnIdsAfter'], 'recovery_turn_changed')
        require(result['recovery']['piMessageUnchanged'] and result['recovery']['piSettledAfter'] == settled_before == 1, 'recovery_pi_changed')
        result['controlEvents'] = read_jsonl(probe.scratch / 'control-events.jsonl')
        result['piEvents'] = read_jsonl(probe.telemetry)
        result['status'] = 'PASS'
    except Exception as error:
        result['errorType'] = type(error).__name__
        # Exceptions contain labels only. Never export native payloads or stderr.
        result['error'] = str(error)[:180] if isinstance(error, (RuntimeError, TimeoutError, KeyError)) else 'inspect_private_scratch'
        result['controlEvents'] = read_jsonl(probe.scratch / 'control-events.jsonl')
    finally:
        if probe.native is not None:
            try:
                probe.native.rpc('thread/archive', {'threadId': probe.native.sid})
                probe.native.rpc('thread/delete', {'threadId': probe.native.sid})
                result['ownedCodexThreadDeleted'] = True
            except Exception:
                result['ownedCodexThreadDeleted'] = False
                result['status'] = 'FAIL'
        result['cleanup'] = probe.cleanup()
        require(all(sha(ROOT / p) == h for p, h in target['sourceSha256'].items()), 'source_changed_during_probe')
        if not result['cleanup']['ownedProcessesStopped'] or not result['cleanup']['ownedPiSocketRemoved']:
            result['status'] = 'FAIL'
        (OPS / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'status': result['status'], 'error': result.get('error'), 'result': str(OPS / 'result.json'), 'privateScratch': str(probe.scratch)}))
    if result['status'] != 'PASS':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
