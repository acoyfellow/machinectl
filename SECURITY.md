# Security Policy

## Scope

`machinectl` intentionally exposes high-privilege local capabilities to an authenticated MCP caller. Its core `shell` tool is terminal-equivalent and enabled by default; optional pi RPC tools control local pi session content and execution when explicitly enabled. This is a deliberate trust model, not a sandbox boundary.

The security boundary this project aims to provide is:

- the laptop connects outbound only to the configured Worker endpoint;
- the Worker endpoint must authenticate callers with Cloudflare Access or an equivalent operator-owned policy;
- tool calls are auditable at the Worker boundary;
- explicit `shell.cwd` values and optional pi session locations enforce configured allowed roots;
- shell and optional pi child processes are cleaned up on timeout or daemon shutdown.

## Operator responsibility

Do not run `machinectl` unless you trust:

- the MCP clients permitted by your Access policy;
- the model or human sending commands;
- the Worker deployment configured by `MACHINECTL_URL`.

`shell` can read credentials, execute arbitrary programs, delete files, or exfiltrate data as the local user. `MACHINECTL_ALLOWED_PATHS` does not confine arbitrary shell command content. `screenshot`, `mouse`, and `keyboard` may disclose or operate sensitive logged-in desktop state. Optional pi RPC tools may disclose prompts, transcripts, and local session state. `local_auth_status` is diagnostic-only: it forwards a bounded allowlisted projection from `cf-local status --json --remote`; callers must never auto-run recovery commands or trigger interactive relinking without explicit operator confirmation.

## Reporting vulnerabilities

Please report vulnerabilities privately through GitHub's **Report a vulnerability** / Security Advisories feature for this repository.

Relevant reports include:

- authentication or identity confusion;
- cross-user or cross-machine tool routing;
- escaping explicit `cwd` or optional pi-session path enforcement;
- missing audit receipts or leakage of secrets beyond documented previews;
- child-process cleanup or lifecycle bypasses.

Please do not publish working exploits before a fix is available.
