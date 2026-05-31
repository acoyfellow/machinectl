# machinectl

Laptop-side daemon for exposing local tools to an MCP client through an authenticated Worker relay.

`machinectl` does not open an inbound server or create a tunnel. It connects outbound to a compatible Worker endpoint, publishes its tool catalog, executes relayed tool calls locally, and sends results back over the same WebSocket.

This repository contains the laptop daemon only. You must provide a compatible Worker-side endpoint and its authentication and audit policy.

## Architecture

```text
MCP client
   │
   │ POST /machinectl/mcp
   ▼
Authenticated Worker endpoint
   │
   │ outbound WebSocket connection initiated by laptop
   ▼
machinectl daemon
   │
   ├── shell / git / file / desktop tools
   ├── live pi RPC sessions
   └── captured OpenCode jobs
```

When the daemon disconnects, no laptop tools are callable through MCP `tools/list`.

## Requirements

- Node.js 20 or later
- A compatible Worker-side `MachineHost` endpoint
- `cloudflared` if the endpoint uses Cloudflare Access authentication
- macOS or Linux for platform-dependent desktop tools

## Install

```bash
git clone https://github.com/acoyfellow/machinectl
cd machinectl
npm install
npm run build
```

## Configure

Set the URL of a trusted compatible Worker endpoint:

```bash
export MACHINECTL_URL=https://machinectl.example.com
```

If the endpoint uses Cloudflare Access, install `cloudflared` and authenticate once:

```bash
brew install cloudflared
cloudflared access login "$MACHINECTL_URL"
```

At startup and reconnect, the daemon obtains the cached token with `cloudflared access token --app="$MACHINECTL_URL"` and sends it in the WebSocket upgrade request. For testing or non-interactive launch environments, set `MACHINECTL_ACCESS_TOKEN` explicitly.

## Run

Choose which directories dedicated file tools and local coding-agent sessions may operate within:

```bash
MACHINECTL_URL=https://machinectl.example.com \
MACHINECTL_ALLOWED_PATHS=/Users/you/projects,/Users/you/work \
  node dist/index.js
```

Example output:

```text
[machinectl] machinectl daemon — machine: "your-macbook"
[machinectl] worker: https://machinectl.example.com
[machinectl] tools registered: exec_command, git, agent_start, agent_list, agent_status, agent_logs, agent_prompt, agent_steer, agent_follow_up, agent_pi_command, agent_abort, agent_stop, read_file, write_file, list_directory, screenshot, processes, clipboard, notify, open
[machinectl] connecting to wss://machinectl.example.com/machinectl/connect as "your-macbook"
[machinectl] connected; publishing tool catalog
```

If `MACHINECTL_ALLOWED_PATHS` is not set, `read_file`, `write_file`, `list_directory`, and `agent_*` are not published. `open` remains available for URLs but rejects local-file targets unless their paths are allowed.

`MACHINECTL_ALLOWED_PATHS` is not a shell sandbox. `exec_command` can access anything available to the local user. In the current release, `git` is also shell-interpreted and must be treated as shell-equivalent.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `MACHINECTL_URL` | required | Trusted compatible Worker endpoint base URL. |
| `MACHINECTL_NAME` | `os.hostname()` | Machine name published to the Worker. |
| `MACHINECTL_ALLOWED_PATHS` | empty | Comma-separated directory roots for dedicated file tools, local-file `open` targets, optional `cwd` validation, and `agent_*` sessions. |
| `MACHINECTL_ACCESS_TOKEN` | unset | Explicit authentication token override instead of retrieving a Cloudflare Access token with `cloudflared`. |
| `MACHINECTL_EXEC_TIMEOUT` | `60000` | Timeout in milliseconds for `exec_command` and `git`. Minimum 1000 ms; no maximum is currently enforced. |
| `MACHINECTL_AGENT_MAX_SESSIONS` | `4` | Maximum concurrently active pi/OpenCode sessions. Range: 1–32. |
| `MACHINECTL_AGENT_MAX_RUNTIME_MS` | `7200000` | Maximum local coding-agent session runtime. Range: 1 minute–24 hours. |
| `MACHINECTL_AGENT_STOP_GRACE_MS` | `5000` | Grace period between `SIGTERM` and `SIGKILL` for agent process groups. |

## Tools

### Machine tools

| Tool | Description | Path behavior |
|---|---|---|
| `exec_command` | Execute a shell command and return stdout/stderr/exit status. | Optional `cwd` is checked; shell command contents are unrestricted. |
| `git` | Execute a shell-interpreted command prefixed with `git` after validating the first subcommand token. | Optional `cwd` is checked; currently shell-equivalent. |
| `read_file` | Read a UTF-8 file, truncated above 256 KB. | Requires allowed path. |
| `write_file` | Write UTF-8 content, creating parent directories. | Requires allowed path. |
| `list_directory` | List a directory; optional recursive traversal with bounded depth. | Requires allowed path. |
| `screenshot` | Capture a PNG screenshot and return base64 data. | No path restriction. |
| `processes` | List top processes by CPU or memory. | No path restriction. |
| `clipboard` | Read or write the system clipboard. | No path restriction. |
| `notify` | Send a system notification. | No path restriction. |
| `open` | Open a URL or local file in the default handler. | URLs unrestricted; file targets checked at call time. |

### Coding-agent tools

`agent_*` tools are published only when `MACHINECTL_ALLOWED_PATHS` is configured.

| Tool | Description |
|---|---|
| `agent_start` | Start a local pi RPC session or captured OpenCode job in an allowed working directory. |
| `agent_list` | List active/recent daemon sessions and optionally discover permitted persisted pi sessions. |
| `agent_status` | Read status and recent structured pi events. |
| `agent_logs` | Read captured stdout/stderr. |
| `agent_prompt` | Send a prompt to a live pi session. |
| `agent_steer` | Queue steering guidance for a running pi session. |
| `agent_follow_up` | Queue follow-up work for a pi session. |
| `agent_pi_command` | Execute an allow-listed pi RPC control command. |
| `agent_abort` | Abort current pi work or terminate an OpenCode job. |
| `agent_stop` | Stop the tracked coding-agent process tree. |

## Pi sessions

Pi runs through its RPC mode:

```text
pi --mode rpc
```

Example MCP tool sequence:

```text
agent_start({
  agent: "pi",
  cwd: "/Users/me/projects/my-app",
  prompt: "inspect the failing tests and explain the likely fix"
})

agent_status({ id: "<returned session id>" })
agent_steer({ id: "<returned session id>", message: "do not modify migrations" })
agent_pi_command({ id: "<returned session id>", command: "get_last_assistant_text" })
agent_stop({ id: "<returned session id>" })
```

Allowed pi control commands include state/messages/stats queries, model and thinking changes, compaction, session naming, fork/clone, session switching, and HTML export. Explicit session paths, session switching paths, and explicit export output paths are validated against configured allowed roots.

Pi session process handles and recent events are held in daemon memory. If the daemon restarts, active control handles are lost; pi-persisted session files may still be reopened later.

## OpenCode jobs

OpenCode runs as a captured bounded process:

```text
opencode run --format json --dir <allowed-directory> <prompt>
```

Use `agent_status`, `agent_logs`, and `agent_stop` to monitor or terminate it. Live prompt and steering controls are currently implemented only for pi.

## Authentication and audit boundary

The Worker endpoint is outside this package and is part of the security boundary. It is responsible for:

- authenticating MCP callers and laptop WebSocket connections;
- routing a caller to the intended machine;
- applying rate, size, and concurrency limits;
- deciding whether and how tool calls are audited;
- retaining, redacting, or discarding sensitive request/result material.

A Worker implementation may retain tool arguments or output excerpts in its audit store. Review that behavior before transmitting secrets, reading sensitive files, copying credentials, or returning secret-bearing command output.

## Security model

`exec_command` is shell-equivalent and enabled by default. The current `git` tool must also be treated as shell-equivalent because its arguments are interpreted by a shell after a first-token check.

Do not run `machinectl` unless you trust:

- the configured Worker endpoint;
- its authentication and audit policy;
- the MCP clients and users authorized to call it;
- the agent or model issuing commands.

Path restrictions apply to dedicated path-based operations and coding-agent session locations. They do not restrict arbitrary shell command contents.

See [SECURITY.md](./SECURITY.md) for vulnerability reporting and additional security guidance.

## Worker protocol

A compatible Worker endpoint must support the protocol in [`src/protocol.ts`](./src/protocol.ts):

- laptop connects to `GET /machinectl/connect` using WebSocket upgrade;
- laptop sends a `hello` frame containing machine name and tool catalog;
- Worker sends `call` frames containing tool name and arguments;
- laptop responds with correlated `result` frames;
- Worker exposes an MCP endpoint, typically `POST /machinectl/mcp`, to its authenticated clients.

The Worker implementation is not included in this repository.

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev
```

## License

MIT. See [LICENSE](./LICENSE).
