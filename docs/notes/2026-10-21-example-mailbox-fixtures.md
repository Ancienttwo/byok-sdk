# Example fixture polling and mailbox wake fallback

## P1: boundary

The shared `openTeam` and `openHost` fixtures run a real embedded server,
HTTP transport, daemon and adapter session. The basic goal and clarification
fixtures use the same transport. Their readiness waits allow five seconds.
The MCP tool fixture already uses a short poll hold.

## P2: delivery path

The mailbox stores each offer durably. A wake hint tells an empty poll to
read again. Hints can be lost. The production fallback is five seconds.
The production empty-poll hold is about fifty seconds.

A five-second fallback can consume the whole five-second fixture wait.
HTTP delivery and session admission still need time after that fallback.
Fault injection that drops only wake hints reproduces the session assertion
with an Offered task, an open daemon connection and no active session.
The same real execution completes with a short fixture poll hold.

## P3: decision and limits

Use a 100 ms empty-poll hold in these four example test fixtures.
Keep the production fallback, public server defaults and existing assertions
and wait timeouts unchanged. Keep the existing second-device presence setting.
The timer part of an empty poll and the default client idle delay is then
100 + 250 = 350 ms. This leaves margin inside the five-second readiness wait;
it is not a hard latency guarantee under arbitrary host load.

The regressions drop only hints from the real wake factory. They keep the
mailbox, HTTP, daemon, adapter and result helper. They require both a real
session and a completed outcome. A nonzero dropped-hint count proves that
the fault path ran. The original fixture settings fail the added cases.

The exact trigger of release CI 39569325556 remains unconfirmed because that
run did not retain task state. This fixture defect and its red/green proof
do not establish that the original CI lost a hint. Final release acceptance
must still pass on the exact merged source and produce new frozen artifacts.
