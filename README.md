# machinectl

Run authenticated MCP tools on your laptop through an outbound connection to a Cloudflare Worker relay.

> **Security:** authorized clients can execute shell commands as your local user and operate your visible desktop through mouse and keyboard input. Only deploy this if you intend to grant terminal-and-desktop-equivalent access.

## Core tools

| Tool | What it does |
|---|---|
| `shell` | Run shell commands as your local user. Use it for files, git, processes, clipboard, notifications, opening apps/URLs, scripts, and any installed coding tool. |
| `screenshot` | Capture the current screen as a PNG image. |
| `mouse` | Move, click, double-click, or scroll the pointer on macOS. |
| `keyboard` | Type text or send keys/shortcuts on macOS. |

Anything command-line-shaped goes through `shell`:

```bash
cat package.json
git status
npm test
pbpaste
printf 'done' | pbcopy
osascript -e 'display notification "finished" with title "machinectl"'
open https://example.com
tmux new-session -d -s task 'npm test'
tmux capture-pane -pt task
```

## Optional pi integration

If you use [pi](https://github.com/badlogic/pi-mono), machinectl can also expose structured live control of local `pi --mode rpc` sessions:

```bash
MACHINECTL_ENABLE_PI=1 \
MACHINECTL_ALLOWED_PATHS="$HOME/projects" \
MACHINECTL_URL=https://machinectl.example.com \
  npm start
```

This adds:

```text
pi_start      pi_list       pi_status     pi_logs
pi_prompt     pi_steer      pi_follow_up  pi_command
pi_abort      pi_stop
```

Pi support is opt-in and local: machinectl starts the pi process on your laptop and retains its RPC handles while the daemon is running. It is not required for shell/screen/mouse/keyboard control. Other coding tools can be run through `shell`.

## How it works

```text
MCP client
    │
    │ authenticated request
    ▼
Cloudflare Worker relay
behind Cloudflare Access
    │
    │ outbound WebSocket initiated by laptop
    ▼
machinectl daemon
    │
    ├── shell / screenshot / mouse / keyboard
    └── optional live pi RPC sessions
```

The daemon does not open an inbound server or create a public tunnel. When it disconnects, its tools are no longer callable through the MCP endpoint.

## Requirements

- Node.js 20 or later
- A Cloudflare account and hostname you control
- Cloudflare Access configured for that hostname
- `cloudflared` installed on the laptop
- macOS for the complete desktop-control surface; shell and screenshots have limited Linux support
- Optional: `pi` on `PATH` when enabling pi RPC integration

## Quick start

### 1. Install

```bash
git clone https://github.com/acoyfellow/machinectl
cd machinectl
npm install
npm run build
```

### 2. Deploy the relay

A reference Cloudflare Worker relay is included. From the cloned `machinectl` directory:

```bash
cd examples/cloudflare-worker-relay
npm install
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc` with:

- your relay hostname, for example `machinectl.example.com`;
- your Cloudflare Access application audience tag;
- your Cloudflare Access team issuer;
- an optional KV namespace for content-minimizing audit receipts.

Then deploy:

```bash
npm run typecheck
npm run deploy
```

See [`examples/cloudflare-worker-relay/README.md`](./examples/cloudflare-worker-relay/README.md) for relay setup details.

### 3. Protect it with Cloudflare Access

Create a Cloudflare Access self-hosted application protecting your relay hostname. Start with an allow policy for only your identity.

Before connecting a laptop, verify the MCP endpoint is gated:

```bash
curl -I https://machinectl.example.com/machinectl/mcp
```

Expected result is a redirect to your Cloudflare Access login. Do not continue if the endpoint is publicly reachable.

### 4. Run the laptop daemon

Return to the cloned `machinectl` directory if necessary, then run:

```bash
export MACHINECTL_URL=https://machinectl.example.com
cloudflared access login "$MACHINECTL_URL"

npm start
```

Expected output:

```text
[machinectl] connecting to wss://machinectl.example.com/machinectl/connect as "your-machine"
[machinectl] connected; publishing tool catalog
```

If you plan to pass explicit working directories to `shell`, configure allowed roots:

```bash
MACHINECTL_URL=https://machinectl.example.com \
MACHINECTL_ALLOWED_PATHS="$HOME/projects" \
  npm start
```

`MACHINECTL_ALLOWED_PATHS` limits explicit `cwd` values passed to `shell` and the directories usable by optional pi sessions. It does **not** sandbox shell command contents.

### 5. Connect an MCP client

Configure your MCP client to use:

```text
https://machinectl.example.com/machinectl/mcp
```

The client must authenticate through your Cloudflare Access policy.

Start with:

```text
screenshot({})
```

or:

```text
shell({ command: "pwd" })
```

## Tool reference

### `shell`

```ts
shell({
  command: "git status --short",
  cwd: "/Users/me/projects/app", // optional; must be within MACHINECTL_ALLOWED_PATHS
  timeoutMs: 60000                // optional
})
```

Runs through `bash -lc`. Output is capped. On timeout or daemon shutdown, machinectl terminates the shell process group.

### `screenshot`

```ts
screenshot({})
```

Returns a PNG data URL (subject to a configurable size limit) and deletes its temporary local capture after reading it. Screen contents may be sensitive.

### `mouse`

```ts
mouse({ action: "move", x: 400, y: 300 })
mouse({ action: "click", x: 400, y: 300 })
mouse({ action: "double_click", x: 400, y: 300 })
mouse({ action: "scroll", delta: -4 })
```

Implemented on macOS using System Events and requires user-approved Accessibility permission.

### `keyboard`

```ts
keyboard({ action: "type", text: "hello" })
keyboard({ action: "key", key: "return" })
keyboard({ action: "key", key: "c", modifiers: ["command"] })
```

Implemented on macOS using System Events and requires user-approved Accessibility permission. Named keys include `return`, `tab`, `escape`, `space`, `delete`, `up`, `down`, `left`, and `right`.

## Pi RPC tool reference

When `MACHINECTL_ENABLE_PI=1` is configured together with `MACHINECTL_ALLOWED_PATHS`, machinectl publishes the following optional tools:

| Tool | Description |
|---|---|
| `pi_start` | Start a live local `pi --mode rpc` session in an allowed directory. |
| `pi_list` | List tracked sessions and optionally permitted persisted pi sessions. |
| `pi_status` | Read structured pi events and current status. |
| `pi_logs` | Read captured process output. |
| `pi_prompt` | Send a prompt to pi. |
| `pi_steer` | Steer an in-progress pi run. |
| `pi_follow_up` | Queue follow-up work. |
| `pi_command` | Run allow-listed pi RPC session/model/control commands. |
| `pi_abort` | Abort current pi work. |
| `pi_stop` | Stop a tracked pi process. |

Example:

```text
pi_start({ cwd: "/Users/me/projects/app" })
pi_prompt({ id: "<session-id>", message: "inspect the failing tests" })
pi_status({ id: "<session-id>" })
pi_steer({ id: "<session-id>", message: "do not modify migrations" })
pi_command({ id: "<session-id>", command: "get_last_assistant_text" })
pi_stop({ id: "<session-id>" })
```

Pi session handles and recent events are held in daemon memory. If the daemon restarts, active handles are lost; pi-persisted session files may still be reopened later.

## Code-mode clients

`machinectl` exposes computer capabilities and an optional pi RPC bridge; it does not itself implement code mode.

Clients that support code mode can orchestrate multiple machinectl calls inside a single execution cell, reducing repeated model/tool round trips:

```js
const status = await tools.shell({ command: "git status --short", cwd: "/Users/me/projects/app" });
const tests = await tools.shell({ command: "npm test", cwd: "/Users/me/projects/app" });
text(status + "\n" + tests);
```

Code-mode policy and JavaScript sandboxing belong to the MCP client or agent harness, not this laptop daemon.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `MACHINECTL_URL` | required | URL of your trusted Worker relay. |
| `MACHINECTL_NAME` | system hostname | Name published for the connected machine. |
| `MACHINECTL_ACCESS_TOKEN` | unset | Explicit token override instead of retrieving a Cloudflare Access token via `cloudflared`. |
| `MACHINECTL_ALLOWED_PATHS` | empty | Allowed explicit `cwd` roots for `shell` and permitted directories for optional pi sessions. |
| `MACHINECTL_SHELL_TIMEOUT` | `60000` | Default `shell` timeout in milliseconds. |
| `MACHINECTL_SCREENSHOT_MAX_BYTES` | `8388608` | Maximum PNG screenshot bytes returned by `screenshot`. |
| `MACHINECTL_ENABLE_PI` | unset | Set to `1` or `true` to publish optional pi RPC tools. Requires allowed paths. |
| `MACHINECTL_PI_MAX_SESSIONS` | `4` | Maximum concurrent tracked pi RPC sessions. |
| `MACHINECTL_PI_MAX_RUNTIME_MS` | `7200000` | Maximum lifetime for a tracked pi RPC session. |
| `MACHINECTL_PI_STOP_GRACE_MS` | `5000` | Grace period before force-killing a stopped pi process group. |

## Relay and audit boundary

The Worker relay is part of the security boundary. It authenticates callers and laptop connections, routes calls, limits requests/results, and applies its audit-retention policy.

The included reference relay verifies Cloudflare Access JWTs, applies basic request/result/concurrency bounds, and optionally stores content-minimizing post-call receipts. It does not store tool result content in receipts.

Review relay policy before sending credentials, capturing sensitive screens, typing into logged-in applications, or transmitting pi prompt/transcript content.

## Security model

An authenticated caller with access to your relay can operate your laptop:

- `shell` can read credentials, modify files, run programs, start coding agents, or exfiltrate data available to your user;
- `screenshot` can reveal sensitive on-screen information;
- `mouse` and `keyboard` can interact with applications already open or authenticated on the desktop;
- optional pi RPC tools can read and control pi session content on your laptop.

Use `machinectl` only when you trust:

- the Cloudflare Access policy protecting the relay;
- the clients and users allowed by that policy;
- the agent or model issuing actions;
- the relay implementation and its audit policy.

See [SECURITY.md](./SECURITY.md).

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev
```

## License

MIT. See [LICENSE](./LICENSE).
