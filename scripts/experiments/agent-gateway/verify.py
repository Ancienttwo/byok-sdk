"""Offline verifier for one bounded agent-gateway probe result.

This never starts a native process or imports the live probe driver. It checks
the stored evidence against the source and native bytes currently on disk.
"""
import hashlib
import json
import pathlib
import sys
import uuid


ROOT = pathlib.Path(__file__).resolve().parents[3]
CODING_PLAN_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4'


class VerificationError(Exception):
    pass


def require(condition, label):
    if not condition:
        raise VerificationError(label)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def as_dict(value, label):
    require(isinstance(value, dict), label)
    return value


def as_list(value, label):
    require(isinstance(value, list), label)
    return value


def as_string(value, label):
    require(isinstance(value, str) and value, label)
    return value


def exact_uuid(value, label):
    text = as_string(value, label)
    try:
        uuid.UUID(text)
    except (ValueError, AttributeError):
        raise VerificationError(label)
    return text


def current_root_path(relative, label):
    require(isinstance(relative, str) and relative and not pathlib.PurePath(relative).is_absolute(), label)
    target = (ROOT / relative).resolve()
    try:
        target.relative_to(ROOT.resolve())
    except ValueError:
        raise VerificationError(label)
    require(target.is_file(), label)
    return target


def verify_hashes(target):
    source_hashes = as_dict(target.get('sourceSha256'), 'source_hashes_missing')
    require(source_hashes, 'source_hashes_empty')
    for relative, expected in source_hashes.items():
        path = current_root_path(relative, 'source_path_invalid')
        require(isinstance(expected, str) and sha256(path) == expected, 'source_hash_mismatch:' + relative)

    native_hashes = as_dict(target.get('nativeSha256'), 'native_hashes_missing')
    require(native_hashes, 'native_hashes_empty')
    for raw_path, expected in native_hashes.items():
        path = pathlib.Path(as_string(raw_path, 'native_path_invalid')).resolve()
        require(path.is_file(), 'native_path_invalid')
        require(isinstance(expected, str) and sha256(path) == expected, 'native_hash_mismatch:' + str(path))


def verify_target(target):
    versions = as_dict(target.get('versions'), 'versions_missing')
    require(versions.get('pi') == '0.85.1', 'pi_version_mismatch')
    require(versions.get('codex') == 'codex-cli 0.154.0', 'codex_version_mismatch')
    pi = as_dict(target.get('pi'), 'target_pi_missing')
    require(pi.get('provider') == 'zai', 'target_pi_provider_mismatch')
    require(pi.get('modelId') == 'glm-5.3-flash', 'target_pi_model_mismatch')
    require(pi.get('baseUrl') == CODING_PLAN_ENDPOINT, 'target_pi_endpoint_mismatch')
    codex = as_dict(target.get('codex'), 'target_codex_missing')
    require(codex.get('modelId') == 'gpt-6-astra', 'target_codex_model_mismatch')
    verify_hashes(target)


def parse_body(message, label):
    body = as_string(message.get('body'), label)
    try:
        return as_dict(json.loads(body), label)
    except json.JSONDecodeError:
        raise VerificationError(label)


def verify_messages(result):
    request_id = exact_uuid(result.get('requestId'), 'request_id_invalid')
    before = as_dict(result.get('beforeRecovery'), 'before_recovery_missing')
    after = as_dict(result.get('afterRecovery'), 'after_recovery_missing')
    require(before == after, 'recovery_inspect_changed')
    messages = as_list(before.get('messages'), 'messages_missing')
    require(len(messages) == 3, 'message_count')
    expected_senders = ['alice', 'bob', 'alice']
    expected_kinds = ['request', 'reply', 'acknowledgement']
    bodies = []
    message_ids = []
    for index, message in enumerate(messages, 1):
        message = as_dict(message, 'message_invalid')
        require(message.get('seq') == index, 'message_sequence_mismatch')
        require(message.get('senderMemberId') == expected_senders[index - 1], 'message_sender_mismatch')
        message_ids.append(exact_uuid(message.get('messageId'), 'message_id_invalid'))
        body = parse_body(message, 'message_body_invalid')
        require(body.get('requestId') == request_id, 'message_request_id_mismatch')
        require(body.get('kind') == expected_kinds[index - 1], 'message_kind_mismatch')
        bodies.append(body)
    require(len(set(message_ids)) == 3, 'message_ids_not_unique')
    require(bodies[1].get('replyTo') == message_ids[0] and bodies[1].get('answer') == 'blue', 'pi_reply_mismatch')
    require(bodies[2].get('replyTo') == message_ids[1] and bodies[2].get('accepted') is True, 'codex_ack_mismatch')

    seed = as_dict(result.get('seed'), 'seed_missing')
    require(seed.get('accepted') is True and seed.get('durable') is True, 'seed_not_durable')
    require(seed.get('messageId') == message_ids[0], 'seed_message_id_mismatch')
    return before, after, messages, message_ids


def receipts(snapshot, expected, label):
    stored = as_dict(snapshot.get('receipts'), label)
    for member, cursor in expected.items():
        receipt = as_dict(stored.get(member), label)
        require(receipt.get('acknowledgedThroughSeq') == cursor, label)
        require(receipt.get('deliveredThroughSeq') == cursor, label)


def verify_delivery_and_control(result, before, messages, message_ids):
    after_pi = as_dict(result.get('afterPi'), 'after_pi_missing')
    after_pi_messages = as_list(after_pi.get('messages'), 'after_pi_messages_missing')
    require(len(after_pi_messages) == 2, 'after_pi_message_count')
    receipts(after_pi, {'bob': 2}, 'after_pi_bob_receipt_mismatch')
    receipts(before, {'alice': 3, 'bob': 2}, 'final_receipt_mismatch')

    events = as_list(result.get('controlEvents'), 'control_events_missing')
    posts = [as_dict(event, 'control_event_invalid') for event in events if as_dict(event, 'control_event_invalid').get('method') == 'post']
    require(len(posts) == 3, 'control_post_count')
    for index, event in enumerate(posts):
        require(event.get('seq') == index + 1, 'control_post_sequence_mismatch')
        require(event.get('member') == ['alice', 'bob', 'alice'][index], 'control_post_member_mismatch')
        require(event.get('messageId') == message_ids[index], 'control_post_id_mismatch')
        require(parse_body(event, 'control_post_body_invalid').get('requestId') == result['requestId'], 'control_post_request_mismatch')

    reads = [as_dict(event, 'control_event_invalid') for event in events if as_dict(event, 'control_event_invalid').get('method') == 'read']
    acks = [as_dict(event, 'control_event_invalid') for event in events if as_dict(event, 'control_event_invalid').get('method') == 'ack']
    require(any(event.get('member') == 'bob' and event.get('deliveredThroughSeq') == 2 for event in reads), 'bob_read_missing')
    require(any(event.get('member') == 'alice' and event.get('deliveredThroughSeq') == 3 for event in reads), 'alice_read_missing')
    require(any(event.get('member') == 'bob' and event.get('throughSeq') == 2 for event in acks), 'bob_ack_missing')
    require(any(event.get('member') == 'alice' and event.get('throughSeq') == 3 for event in acks), 'alice_ack_missing')


def verify_native(result):
    pi_start = as_dict(result.get('piStart'), 'pi_start_missing')
    pi_session = exact_uuid(pi_start.get('sessionId'), 'pi_session_invalid')
    require(pi_start.get('modelProvider') == 'zai', 'pi_provider_mismatch')
    require(pi_start.get('modelId') == 'glm-5.3-flash', 'pi_model_mismatch')
    require(pi_start.get('baseUrl') == CODING_PLAN_ENDPOINT, 'pi_endpoint_mismatch')
    codex_session = exact_uuid(result.get('codexSessionId'), 'codex_session_invalid')
    codex_turn = as_dict(result.get('codexTurn'), 'codex_turn_missing')
    exact_uuid(codex_turn.get('id'), 'codex_turn_id_invalid')
    require(codex_turn.get('status') == 'completed', 'codex_turn_not_completed')
    queue = result.get('codexQueueAcceptance')
    require(isinstance(queue, str) and queue.strip(), 'codex_queue_acceptance_missing')

    pi_input = as_dict(result.get('piInputAcceptance'), 'pi_input_acceptance_missing')
    require(pi_input.get('success') is True, 'pi_input_not_accepted')
    pi_input_data = as_dict(pi_input.get('data'), 'pi_input_data_missing')
    require(pi_input_data.get('delivered') is True, 'pi_input_not_delivered')
    inputs = as_list(result.get('nativeInputs'), 'native_inputs_missing')
    require(len(inputs) == 2, 'native_input_count')
    require(inputs == [
        {'harness': 'pi', 'sessionId': pi_session, 'requestId': result['requestId']},
        {'harness': 'codex', 'sessionId': codex_session, 'requestId': result['requestId']},
    ], 'native_inputs_mismatch')

    pi_events = as_list(result.get('piEvents'), 'pi_events_missing')
    start_events = [as_dict(event, 'pi_event_invalid') for event in pi_events if as_dict(event, 'pi_event_invalid').get('event') == 'session_start']
    settled_events = [as_dict(event, 'pi_event_invalid') for event in pi_events if as_dict(event, 'pi_event_invalid').get('event') == 'agent_settled']
    require(len(start_events) == 1 and start_events[0].get('sessionId') == pi_session, 'pi_observer_start_mismatch')
    require(start_events[0].get('modelProvider') == 'zai' and start_events[0].get('modelId') == 'glm-5.3-flash', 'pi_observer_model_mismatch')
    require(start_events[0].get('baseUrl') == CODING_PLAN_ENDPOINT, 'pi_observer_endpoint_mismatch')
    require(len(settled_events) == 1 and settled_events[0].get('sessionId') == pi_session, 'pi_settlement_mismatch')
    return pi_session, codex_session


def verify_recovery(result, pi_session, codex_session):
    recovery = as_dict(result.get('recovery'), 'recovery_missing')
    require(recovery.get('piSessionId') == pi_session, 'recovery_pi_session_mismatch')
    require(recovery.get('codexSessionId') == codex_session, 'recovery_codex_session_mismatch')
    require(recovery.get('storeUnchanged') is True, 'recovery_store_changed')
    require(recovery.get('piMessageUnchanged') is True, 'recovery_pi_message_changed')
    require(recovery.get('unknownDeliveryResends') == 0, 'recovery_resend_detected')
    before_turns = as_list(recovery.get('codexTurnIdsBefore'), 'recovery_turns_before_missing')
    after_turns = as_list(recovery.get('codexTurnIdsAfter'), 'recovery_turns_after_missing')
    require(before_turns == after_turns and before_turns, 'recovery_turns_changed')
    require(recovery.get('piSettledBefore') == 1 and recovery.get('piSettledAfter') == 1, 'recovery_additional_settlement')


def verify_negative_and_cleanup(result):
    negative = as_dict(result.get('negative'), 'negative_missing')
    expected = [
        'wrongPiSessionRejectedBeforeConnect',
        'missingSocketRefused',
        'wrongCodexSessionRejectedBeforeQueue',
        'wrongRequestRejected',
    ]
    require(set(negative) == set(expected) and all(negative[key] is True for key in expected), 'negative_cases_failed')
    require(result.get('ownedCodexThreadDeleted') is True, 'codex_thread_cleanup_failed')
    cleanup = as_dict(result.get('cleanup'), 'cleanup_missing')
    require(cleanup.get('ownedProcessesStopped') is True, 'owned_process_cleanup_failed')
    require(cleanup.get('ownedPiSocketRemoved') is True, 'owned_socket_cleanup_failed')


def verify(result):
    require(result.get('schema') == 1, 'schema_mismatch')
    require(result.get('status') == 'PASS', 'result_not_pass')
    target = as_dict(result.get('target'), 'target_missing')
    verify_target(target)
    before, _after, messages, message_ids = verify_messages(result)
    verify_delivery_and_control(result, before, messages, message_ids)
    pi_session, codex_session = verify_native(result)
    verify_recovery(result, pi_session, codex_session)
    verify_negative_and_cleanup(result)


def main(argv):
    if len(argv) != 2:
        raise VerificationError('usage: verify.py RESULT_JSON')
    path = pathlib.Path(argv[1])
    require(path.is_file(), 'result_missing')
    try:
        result = as_dict(json.loads(path.read_text()), 'result_invalid')
    except json.JSONDecodeError:
        raise VerificationError('result_invalid')
    verify(result)
    print(json.dumps({'status': 'VERIFY_PASS', 'result': str(path)}))


if __name__ == '__main__':
    try:
        main(sys.argv)
    except VerificationError as error:
        print(json.dumps({'status': 'VERIFY_FAIL', 'reason': str(error)}), file=sys.stderr)
        raise SystemExit(1)
