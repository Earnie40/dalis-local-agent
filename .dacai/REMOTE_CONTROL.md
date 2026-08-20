# Remote Control Boundary

The coding-agent server remains bound to `127.0.0.1`.

This parity pack intentionally does **not** expose filesystem/shell/approval APIs directly to the public internet. A production remote-control plane should use an authenticated outbound relay or private overlay network and must preserve:

- explicit user identity;
- per-session authorization;
- approval prompts for mutation/high-impact actions;
- encrypted transport;
- audit logging;
- replay protection;
- ability to revoke a device/session;
- no direct public binding of the local Fastify server.

The local agent now has durable task/checkpoint state, so an authenticated relay can be added later without changing execution semantics.
