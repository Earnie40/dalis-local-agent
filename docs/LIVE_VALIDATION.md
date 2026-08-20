# Tomahawk1 LIVE_VALIDATION

`LIVE_VALIDATION` is the production-style adversarial-validation path. It is
separate from `SIMULATION`, which remains available for unit tests and CI. A
live run never falls back to simulation when a target, safety service, or
observation source is unavailable.

## Control boundary

```text
Tomahawk1 Test Agents
        |
        v
LiveValidationSafetyController  <--- durable emergency-stop latch
        |
        v
Exact host/IP/CIDR allowlist     <--- DNS resolved and rechecked before I/O
        |
        v
Isolated Tomahawk1 test network
        |
        X  external firewall / HARD_NETWORK_STOP
        |
Public Internet
```

The application controller is the first stop mechanism. `HardNetworkStopProvider`
is the independent final-containment interface. The included
`ProcessHardNetworkStopProvider` invokes a trusted infrastructure-owned firewall
helper with `shell: false`; the helper must disable test-agent egress outside the
application process and should be deployed with separately controlled privilege.

## Required live-run inputs

A live controller will not start without all of the following:

- literal mode `LIVE_VALIDATION`;
- test ID and operator identity;
- authorization-evidence ID matching the active engagement;
- a nonempty exact hostname/IP or private-CIDR allowlist (wildcards are rejected);
- finite duration, expiration, action-count, concurrency, throughput, and total-byte limits;
- a working append-only audit sink and system-health monitor;
- a safety heartbeat within its configured timeout;
- an external network-isolation provider when `hardNetworkStop` is enabled.

Every destination is resolved before execution and again immediately before
I/O. All resolved addresses must be private/link-local/loopback lab addresses.
Mixed public/private DNS results, public addresses, resolution failure, and
allowlist mismatch trigger the global circuit breaker.

## Observations and audit

Live drivers return only `source: LIVE_ENVIRONMENT`. Service responses,
telemetry, detections, Tomahawk1 responses, containment events, and recovery
events retain that provenance. A simulated or unknown source trips the circuit
breaker. Results and logs store `EXPECTED_RESULT` independently from
`OBSERVED_RESULT`; neither value replaces the other.

The JSONL audit sink records run start/end, scope, operator, authorization,
target resolution/contact, attempted actions, observed results, detections,
responses, containment/recovery evidence, circuit breakers, kill-switch events,
traffic totals, and termination reason. Its records always contain
`executionMode: LIVE_VALIDATION` and pass through the platform secret redactor.

## Emergency controls

Set `TOMAHAWK1_EMERGENCY_STOP=true`, call `stopAllLiveValidation()`, POST to
`/api/security/live-validation/stop`, or run:

```powershell
pnpm tomahawk stop --reason "operator containment"
pnpm tomahawk stop --hard-network-stop --reason "network propagation"
```

Stop is durable: new actions are rejected, queued work is cancelled, active
workers receive an abort signal, outbound sessions are closed, and the reason
is audited. A process restart does not clear the latch. Restart requires the
environment latch to be cleared and an explicit operator acknowledgement:

```powershell
pnpm tomahawk restart --operator alice --acknowledgement "RESTART LIVE VALIDATION"
```

`TOMAHAWK1_CONTROL_URL` is restricted to loopback. The server itself also binds
to loopback, keeping the emergency control plane local to the test host.
