# Security Policy

## Scope

`machinectl` intentionally exposes high-privilege local capabilities to an authenticated MCP caller, including `exec_command`, which is shell-equivalent and enabled by default. This is a deliberate trust model, not a sandbox boundary.

The security boundary this project aims to provide is:

- the laptop connects outbound only to the configured Worker endpoint;
- the Worker endpoint must authenticate callers with Cloudflare Access or an equivalent operator-owned policy;
- tool calls are auditable at the Worker boundary;
- explicitly path-scoped tools and coding-agent session operations enforce configured allowed roots;
- local coding-agent child processes are bounded and cleaned up on daemon shutdown.

## Operator responsibility

Do not run `machinectl` unless you trust:

- the MCP clients permitted by your Access policy;
- the model or human sending commands;
- the Worker deployment configured by `MACHINECTL_URL`.

`exec_command` can read credentials, execute arbitrary programs, delete files, or exfiltrate data as the local user. `MACHINECTL_ALLOWED_PATHS` does not confine arbitrary shell command content.

## Reporting vulnerabilities

Please report vulnerabilities privately through GitHub's **Report a vulnerability** / Security Advisories feature for this repository.

Relevant reports include:

- authentication or identity confusion;
- cross-user or cross-machine tool routing;
- escaping path enforcement in path-scoped tools or `agent_*` controls;
- missing audit receipts or leakage of secrets beyond documented previews;
- child-process cleanup or lifecycle bypasses.

Please do not publish working exploits before a fix is available.
