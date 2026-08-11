# Security Policy

## Scope

`machinectl` intentionally exposes high-privilege local capabilities to an authenticated MCP caller. Its `shell` tool is terminal-equivalent and off by default, behind `MACHINECTL_ENABLE_SHELL`; optional delegated-agent harness tools control local session content and execution when explicitly enabled. Pi is the first adapter. The opt-in cmux adapter exposes only fixed semantic operations over cmux's private local socket and verifies Pi surface ownership before mutation. This is a deliberate trust model, not a sandbox boundary.

The security boundary this project aims to provide is:

- the laptop connects outbound only to the configured Worker endpoint;
- the Worker endpoint must authenticate callers with Cloudflare Access or an equivalent operator-owned policy;
- tool calls are auditable at the Worker boundary;
- explicit `shell.cwd` values and optional pi session locations enforce configured allowed roots;
- shell and optional pi child processes are cleaned up on timeout or daemon shutdown;
- the daemon refuses to start when the configured capabilities contradict the configured policy.

## Delegated agents and permission policy

`MACHINECTL_ACP_PERMISSION` (`deny` by default, or `ask` / `allow`) binds only an agent that actually requests permission. An agent that writes files without asking ignores the policy, and `MACHINECTL_ALLOWED_PATHS` does not confine it, because only reads and writes routed through machinectl's own RPC methods are path-checked; the agent's direct filesystem access is not.

The daemon therefore refuses to start when `MACHINECTL_ACP_PERMISSION` is `deny` or `ask` while an agent known to ignore permission requests is enabled. Set `MACHINECTL_ACP_ALLOW_UNGOVERNED=1` to accept explicitly that such an agent runs with your full user permissions. Under a `deny` policy the daemon also stops advertising a write capability to agents at handshake, so an agent is not offered a write path the policy is meant to refuse.

A delegated agent receives a copy of the ambient environment because it needs its own model credentials, with `MACHINECTL_ACCESS_TOKEN` removed. On Linux, however, a same-user delegated agent may inspect the daemon's original environment through `/proc`; removing the variable from its direct environment is not a guarantee that an Access-token override is unreadable. Use this filtering to avoid ordinary child-process inheritance, not as an isolation boundary.

## Machine connection lifetime

The relay example verifies the Cloudflare Access assertion when the daemon opens its WebSocket, and binds that connection to the verified `exp` claim. The expiry travels to the Durable Object on the same relay-set identity headers as the email and subject, and is stored on the socket. An expired connection is closed with code 1008, is not selected to serve a call, is refused at tool invocation, and does not accept an inbound frame; in-flight calls are failed rather than left to hang. A Durable Object alarm closes an expired connection that is otherwise idle, so a socket that sends nothing is still disconnected at expiry.

This bounds a connection to the lifetime of the assertion that opened it. It is not revocation enforcement. Revoking a user in Cloudflare Access does not close a live connection at the moment of revocation: the connection survives until the already-issued assertion expires. Because the daemon requests a fresh Access token on every reconnect attempt, a revoked identity fails to re-establish the connection once its assertion expires. The residual exposure is therefore bounded by the remaining lifetime of an assertion that was valid when the connection opened, and an operator who needs an immediate cutoff must stop the daemon or remove the relay deployment rather than rely on an Access policy change alone.

## Operator responsibility

Do not run `machinectl` unless you trust:

- the MCP clients permitted by your Access policy;
- the model or human sending commands;
- the Worker deployment configured by `MACHINECTL_URL`.

`shell` can read credentials, execute arbitrary programs, delete files, or exfiltrate data as the local user. `MACHINECTL_ENABLE_SHELL` withholds the tool by default. Once enabled, `MACHINECTL_ALLOWED_PATHS` supplies the working directory and rejects a `cwd` outside its roots, and the command's direct environment is scrubbed to neutral variables plus the `MACHINECTL_SHELL_ENV_PASSTHROUGH` allowlist; `MACHINECTL_ACCESS_TOKEN` is excluded even if listed. On Linux, a same-user command may still inspect the daemon's original environment through `/proc`, so this filtering does not guarantee that an Access-token override is unreadable. These controls bound the working directory and the directly inherited environment; they do not confine arbitrary shell command content. `screenshot`, `mouse`, and `keyboard` may disclose or operate sensitive logged-in desktop state. Optional delegated-agent harness tools may disclose prompts, transcripts, and local session state. Optional cmux tools may disclose bounded terminal tails and submit input to a verified Pi surface; they reject multiline input, stale/ambiguous mappings, non-Pi processes, and invalid lifecycle transitions. `local_auth_status` is diagnostic-only: it forwards a bounded allowlisted projection from `cf-local status --json --remote`; callers must never auto-run recovery commands or trigger interactive relinking without explicit operator confirmation.

Do not use an uncontained host relay for workloads whose data-handling policy requires container isolation, credential-file blocking, or a read-only working directory. In those environments, run the approved contained workflow instead of treating machinectl's operator warning as a compensating control.

## Reporting vulnerabilities

Please report vulnerabilities privately through GitHub's **Report a vulnerability** / Security Advisories feature for this repository.

Relevant reports include:

- authentication or identity confusion;
- cross-user or cross-machine tool routing;
- escaping explicit `cwd` or optional pi-session path enforcement;
- a tool result that is altered but still reported as successful;
- missing audit receipts or leakage of secrets beyond documented previews;
- child-process cleanup or lifecycle bypasses.

Please do not publish working exploits before a fix is available.
