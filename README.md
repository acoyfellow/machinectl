# machinectl

**Control your computer from a remote location. Control the agents on it too.**

![The Code Mode control client. It is connected to a local machine. It shows the terminal output and the agent controls.](docs/screenshots/codemode-control.png)

`machinectl` is a small daemon. It makes your computer an authenticated MCP endpoint. It uses an outbound WebSocket connection. Your computer has no inbound listener. You need no tunnel to your desktop. You need no hosted service.

`machinectl` controls two layers:

| Layer | What you get |
|---|---|
| **The machine** | The shell, screen capture, screen recording, the mouse, the keyboard, grouped input, and macOS accessibility. |
| **The agents on it** | Find, start, prompt, steer, monitor, and stop the local agent sessions. This includes the sessions that already operate in a cmux workspace. |

A remote-desktop tool controls only the first layer. An agent tool does not connect to your computer. `machinectl` controls both layers. You control the agent, and the agent does the work.

[`pi`](https://github.com/badlogic/pi-mono) has its own adapter. One [ACP](https://agentclientprotocol.com) adapter controls the approximately 36 agents that speak the Agent Client Protocol. These agents include Codex, Claude, OpenCode, Gemini, and Amp. To add an agent, write an adapter.

This repository includes a small Code Mode control client. Use it for a local test, or install it behind an Access policy that you control. There is no shared hosted demonstration.

```text
phone / MCP client
        │ authenticated through your relay
        ▼
Cloudflare Access + Worker relay
        │ outbound WebSocket opened by your laptop
        ▼
machinectl daemon on your computer
        ├── shell / screenshot / mouse / keyboard / input_sequence / accessibility_query / accessibility_action
        ├── local_auth_status
        └── optional delegated-agent harness sessions
```

Your computer has no inbound listener. It has no public tunnel. When the daemon disconnects, the relay removes its tools.

> **WARNING: `machinectl` has full control of your computer.** A person who can use your connected relay can run commands as your local user. That person can also operate your desktop. Use `machinectl` only behind authentication that you control.

## What you can do

| Capability | Tool | Examples |
|---|---|---|
| Use the terminal | `shell` | Files, git, builds, scripts, and installed CLI programs. Use platform commands for the clipboard and for notifications. |
| See the computer | `screenshot` | Capture a compressed preview. To get an exact image, request the PNG format. |
| Control the computer | `mouse`, `keyboard`, `input_sequence` | Move, click, and scroll. Type text. Send shortcuts. Send a group of inputs when the delay must be small. |
| Examine the user interface | `accessibility_query`, `accessibility_action` | Find and operate macOS accessibility elements. You do not calculate pixel coordinates. |
| Examine the local login | `local_auth_status` | A short health summary from `cf-local`. It contains no secrets. |
| Control delegated agents | `harness_*` (optional) | Find the adapters. Start, prompt, control, monitor, stop, and end a session. Use the Pi adapter or any ACP agent. |
| Control cmux workspaces | `cmux_*` (optional) | Find the permanent workspaces. Read the recent Pi terminal output. Prompt, steer, stop, or select a Pi surface after machinectl verifies it. |

### Example: ordinary computer control

```text
shell({ command: "git status --short", cwd: "/Users/me/projects/app" })
screenshot({}) // compressed JPEG preview by default
screenshot({ format: "png", fullResolution: true }) // exact inspection
input_sequence({ actions: [
  { action: "click", x: 420, y: 300 },
  { action: "type", text: "npm test" },
  { action: "key", key: "return" }
] })
```

### Example: delegated-agent harness control

```text
harness_catalog({})
harness_start({ harnessId: "pi", cwd: "/Users/me/projects/app" })
harness_prompt({ harnessId: "pi", id: "<session-id>", message: "Inspect the failing tests and fix them." })
harness_steer({ harnessId: "pi", id: "<session-id>", message: "Do not modify migrations." })
harness_control({ harnessId: "pi", id: "<session-id>", command: "get_last_assistant_text" })
harness_stop({ harnessId: "pi", id: "<session-id>" })
```

The same operations control any ACP agent. In this example, Codex starts in `read-only` mode. It requests permission before it writes a file. It then waits for your decision. You can send the decision from a remote location.

```text
harness_start({ harnessId: "codex", cwd: "/Users/me/projects/app" })
harness_prompt({ id: "<session-id>", message: "Add a regression test for the parser bug." })
harness_control({ id: "<session-id>", command: "pending_permissions" })
harness_control({ id: "<session-id>", command: "resolve_permission",
                  args: { requestId: "perm-1", optionId: "allow_once" } })
```

## Why this is different

`machinectl` is not a cloud sandbox. It is not a Screen Sharing server. It is not a desktop assistant application. It is an authenticated outbound control channel to a **computer that you own**:

- A sandbox system has its own files. `machinectl` uses the applications, the files, and the sessions on your computer.
- A remote desktop program needs an inbound service. `machinectl` needs no inbound service.
- A local automation program operates only on one computer. `machinectl` makes these capabilities available to a different authenticated device or agent.
- A desktop assistant has many functions. `machinectl` stays small. It has the transport, the machine capabilities, and the agent adapters.

## Built with Cloudflare

The reference architecture shows a Cloudflare device-connector pattern:

| Primitive | Role |
|---|---|
| Cloudflare Access | Authenticates the user or the agent that can connect to a private device with high permissions. |
| Workers | Hosts the MCP relay endpoint and policy boundary. |
| Durable Objects | Sends each message to the one connected computer for each authenticated identity. |
| WebSocket Hibernation | Decreases the cost of the permanent device channel. |
| KV, optional | Stores short audit records. The records contain no command output. |
| Code Mode and Dynamic Workers | A client can control the small machine tool surface with generated code in an isolated environment. |

The installed client uses Code Mode as its primary interface to the model. This repository also includes a small Code Mode control client example. Use it for a local test or for a private installation. The basic relay example is also available. Use that example when you want the smallest MCP bridge that you can examine.

## Architecture

`machinectl` is the **daemon on your computer**. A remote caller needs a compatible authenticated relay. This repository includes a Cloudflare Worker relay that you can install. Refer to [`examples/cloudflare-worker-relay`](./examples/cloudflare-worker-relay/).

```text
┌──────────────────────────────┐
│ Authenticated MCP client      │
└──────────────┬───────────────┘
               │ POST /machinectl/mcp
┌──────────────▼───────────────┐
│ Cloudflare Worker relay       │
│ Access auth + MachineHost DO  │
│ optional minimal receipts     │
└──────────────┬───────────────┘
               │ persistent outbound WebSocket
┌──────────────▼───────────────┐
│ Your laptop                  │
│ machinectl daemon             │
└──────────────────────────────┘
```

The relay is separate from the daemon. Use the supplied Cloudflare implementation, or supply a different authenticated endpoint. A different endpoint must use the wire protocol in [`src/protocol.ts`](./src/protocol.ts).

This repository includes two examples of a client and a relay:

| Example | Use it for |
|---|---|
| [`examples/cloudflare-worker-relay`](./examples/cloudflare-worker-relay/) | Smallest raw MCP relay behind Cloudflare Access. |
| [`examples/codemode-control`](./examples/codemode-control/) | Thin private control page plus Code Mode-first MCP endpoint backed by Dynamic Workers. |

## Quick start

### Requirements

- Node.js 20+
- macOS, for all screen, mouse, and keyboard functions
  - shell and screenshot have limited Linux support
- A trusted compatible Worker relay
  - the included Cloudflare Worker example requires a Cloudflare account, hostname and Access application
- `cloudflared` on the laptop when authenticating to a Cloudflare Access-protected relay
- Optional: `pi` on `PATH` for live structured Pi RPC control

### 1. Install the daemon

```bash
git clone https://github.com/acoyfellow/machinectl
cd machinectl
npm install
npm run build
```

### 2. Deploy a private relay

The included reference relay is under [`examples/cloudflare-worker-relay`](./examples/cloudflare-worker-relay/):

```bash
cd examples/cloudflare-worker-relay
npm install
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc` with:

- A hostname that you control, for example `machinectl.example.com`.
- The audience tag of your Cloudflare Access application.
- The issuer of your Access team.
- optionally, a KV namespace for content-minimizing audit receipts.

Deploy it:

```bash
npm run typecheck
npm run deploy
```

Protect the hostname with a Cloudflare Access self-hosted application before connecting a laptop. Verify the MCP path is not publicly callable:

```bash
curl -I https://machinectl.example.com/machinectl/mcp
```

You should be required to authenticate through Access.

### 3. Connect your laptop

From the repository root:

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

For explicit working directories and optional delegated-agent adapters:

```bash
MACHINECTL_URL=https://machinectl.example.com \
MACHINECTL_ALLOWED_PATHS="$HOME/projects" \
MACHINECTL_ENABLE_PI=1 \
  npm start
```

### 4. Connect an MCP client

Point an Access-capable MCP client at:

```text
https://machinectl.example.com/machinectl/mcp
```

Start safely:

```text
screenshot({})
shell({ command: "pwd" })
```

## Tools

### Core computer-control tools

#### `shell`

```ts
shell({
  command: "npm test",
  cwd: "/Users/me/projects/app", // optional; requires MACHINECTL_ALLOWED_PATHS
  timeoutMs: 60000                // optional
})
```

Runs through `bash -lc` as the daemon user. Output is capped. On timeout or daemon shutdown, machinectl terminates the shell process group.

`shell` is off by default. Set `MACHINECTL_ENABLE_SHELL=1` to publish it.

Three controls bound it:

| Control | Effect |
| --- | --- |
| `MACHINECTL_ENABLE_SHELL` | Withholds the tool completely when unset. |
| `MACHINECTL_ALLOWED_PATHS` | Validates an explicit `cwd`, and supplies the working directory when the caller omits one. |
| `MACHINECTL_SHELL_ENV_PASSTHROUGH` | Names the extra environment variables a command may read. |

The command's direct environment holds `HOME`, `LANG`, `LC_ALL`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `TZ`, `USER`, and your passthrough list. `MACHINECTL_ACCESS_TOKEN` is excluded even if it appears in the passthrough list.

These controls limit the path and the directly inherited environment. They do **not** put the shell command in a sandbox. On Linux, a command running as the same user may inspect the daemon's original environment through `/proc`, so this does not guarantee that an Access-token override is unreadable. A command still runs with your user's file permissions.

#### `screenshot`

```ts
screenshot({})                                           // JPEG preview, max width 1440
screenshot({ format: "jpeg", quality: 55, maxWidth: 1024 }) // low-bandwidth preview
screenshot({ format: "png", fullResolution: true })     // exact/full-resolution inspection
screenshot({ region: { x: 0, y: 0, width: 800, height: 600 } })
```

On macOS, screenshots default to a resized JPEG preview for responsive remote control. Request PNG/full resolution only when exact pixels are necessary. The temporary local capture is deleted after reading. Screen contents may be sensitive.

#### `mouse`

```ts
mouse({ action: "move", x: 400, y: 300 })
mouse({ action: "click", x: 400, y: 300 })
mouse({ action: "double_click", x: 400, y: 300 })
mouse({ action: "scroll", delta: -4 })
```

Implemented on macOS using CoreGraphics pointer events and requires user-approved Accessibility permission.

#### `keyboard`

```ts
keyboard({ action: "type", text: "hello" })
keyboard({ action: "key", key: "return" })
keyboard({ action: "key", key: "c", modifiers: ["command"] })
```

Implemented on macOS using System Events and requires user-approved Accessibility permission.

#### `input_sequence`

```ts
input_sequence({ actions: [
  { action: "click", x: 400, y: 300 },
  { action: "type", text: "hello" },
  { action: "key", key: "return" }
] })
```

This tool does a maximum of 32 mouse actions and keyboard actions in one remote request. It thus decreases the number of messages during interactive work. machinectl does a group of pointer actions together. It also does a group of keyboard actions together. When a group contains both types, machinectl keeps the given sequence. Typed text is sensitive. A compatible relay must remove it from the audit records.

#### `accessibility_query` and `accessibility_action`

```ts
const buttons = accessibility_query({ op: "find", app: "Safari", role: "button", text: "New Tab" })
accessibility_action({ op: "activate", elementId: buttons.nodes[0].elementId })
```

These are the basic tools for a Code Mode client that controls the user interface. `accessibility_query` returns temporary identifiers from the macOS accessibility tree. `accessibility_action` operates only on an identifier from a recent query. An identifier expires quickly. It also changes when the application or the window changes. machinectl limits the depth, the node count, and the text length of a query result. Use an accessibility element when one is available. Do not calculate coordinates from a screenshot.

#### `local_auth_status`

```ts
local_auth_status({})
```

Returns a bounded allowlisted projection from `cf-local status --json --remote`. It is diagnostic-only and should not be used to automatically trigger relinking or interactive recovery steps.

### Optional delegated-agent harness tools

Set the permitted directories and the adapters before you start the daemon:

```bash
MACHINECTL_ALLOWED_PATHS="$HOME/projects"
MACHINECTL_ENABLE_PI=1          # live RPC steering + pi_* compatibility aliases
MACHINECTL_ENABLE_ACP=1         # any Agent Client Protocol agent (refer to below)
MACHINECTL_ENABLE_CMUX=1        # steer existing cmux workspaces/Pi surfaces
```

| Tool | Purpose |
|---|---|
| `harness_catalog` | List the available adapters and their capabilities. |
| `harness_start` | Start a session with a delegated agent. |
| `harness_list` | List the active sessions and the recent sessions. |
| `harness_status` | Read the status and the recent events. |
| `harness_logs` | Read a limited quantity of the process output. |
| `harness_prompt` | Send a prompt. |
| `harness_steer` | Change the work while the agent operates, if the adapter has this capability. |
| `harness_follow_up` | Add subsequent work, if the adapter has this capability. |
| `harness_control` | Send a permitted command to the adapter. |
| `harness_abort` | Stop the current work. |
| `harness_stop` | Stop the processes. machinectl keeps the recorded output in memory. |

Pi is the native adapter. It has all control operations. The `pi_*` tools stay available for older clients, but do not use them in new work. The daemon keeps the process data in memory. When the daemon starts again, it loses the active sessions.

To add an agent, write an adapter. Do not add a tool. The tool table above is the stable interface. Each adapter uses the [`HarnessAdapter`](src/harness/types.ts) interface. Each adapter declares only the capabilities that it has. `harness_steer` thus refuses the operation for an adapter that has no steer method.

### Agent Client Protocol (ACP) agents

[ACP](https://agentclientprotocol.com) is JSON-RPC on stdio. It uses the same transport as Pi. Approximately 36 coding agents speak ACP. One adapter controls all of them. To add an agent, add a launch configuration. You do not write new code.

```bash
MACHINECTL_ENABLE_ACP=1
MACHINECTL_ACP_AGENTS=codex,claude,opencode      # the default is opencode
MACHINECTL_ACP_COMMAND_CODEX="/path/to/codex-acp" # optional: the command for one agent
```

machinectl has launch configurations for `opencode`, `claude`, `codex`, `amp`, and `gemini`. To use a different agent, set `MACHINECTL_ACP_COMMAND_<ID>`. machinectl reads the capabilities from the `initialize` reply of the agent. It does not use a fixed list. `harness_catalog` thus shows the capabilities that each agent has.

These results come from tests with real agents:

| Agent | Package | Session modes | Resume | Control |
|---|---|---|---|---|
| Codex | `@agentclientprotocol/codex-acp` | `read-only`, `agent`, `agent-full-access` | yes | machinectl sets the mode |
| Claude Agent | `@agentclientprotocol/claude-agent-acp` | `plan`, `default`, `acceptEdits`, and more | yes | machinectl sets the mode |
| OpenCode | native (`opencode acp`) | none | yes | the agent decides |
| Amp | `amp-acp` | none | no | the agent decides |

`claude-agent-acp` needs its own credentials in the environment. A `claude` CLI that has a login is not sufficient. machinectl reports this error with the authentication methods of the agent.

#### The limits of machinectl control

A session starts in the mode that has the fewest permissions. Codex starts in `read-only` mode. Claude starts in `plan` mode. The default mode of the agent does not change this. To increase the permissions, send the `set_mode` command with `harness_control`. machinectl refuses a mode that the agent does not have.

The policy controls the answer to a permission request:

| `MACHINECTL_ACP_PERMISSION` | Answer |
|---|---|
| `deny` (default) | Select the refuse option of the agent. |
| `ask` | Hold the request and wait for a user. |
| `allow` | Select the permit option of the agent. The operator must set this value. |

With the `ask` policy, machinectl holds the request and the agent waits. The relay protocol permits only Worker-to-daemon requests. machinectl thus shows a held request with the existing tools. It does not add a new message type.

```
harness_control({ id, command: "pending_permissions" })
harness_control({ id, command: "resolve_permission",
                  args: { requestId: "perm-1", optionId: "allow_once" } })
```

When no user answers before `MACHINECTL_ACP_PERMISSION_TIMEOUT_MS` (default 120 s), machinectl selects the refuse option. machinectl records each decision as a session event with the related operation. This applies to a permitted request, a refused request, and a request that reached the time limit.

machinectl tells the agent that it supplies `fs/read_text_file` and `fs/write_text_file`. When the agent uses these methods, machinectl applies `MACHINECTL_ALLOWED_PATHS` to the path and records the operation.

**WARNING: This is a control point for agents that cooperate. It is also a record of delegated operations. It is not a sandbox.**

These file capabilities do not force an agent to use them. The child process has all of your user permissions. An agent that has an internal write tool can ignore the machinectl control point. Tests with real agents show this behavior. OpenCode writes files. It does not call `fs/write_text_file`, and it does not request permission. Codex in `read-only` mode requests permission, machinectl refuses the request, and the write operation fails.

machinectl can thus control an ACP agent only when the agent has a permission interface or a mode interface. `harness_catalog` and the `acp_ready` event show which agents have one. machinectl marks a session without one as `containment: "agent-discretion"` and gives a warning. For remote work without a user present, use an agent that has session modes.

### Existing cmux workspaces

Set `MACHINECTL_ENABLE_CMUX=1` to publish the cmux adapter. The adapter calls the installed `cmux` CLI with a fixed list of arguments. It uses the private local Unix socket of cmux. The network cannot connect to this socket. Run `cmux hooks pi install --yes` one time, then start Pi again. cmux can then connect each surface to its permanent Pi session.

| Tool | Purpose |
|---|---|
| `cmux_workspace_list` | List workspaces, bounded surface metadata, and paired Pi lifecycle. |
| `cmux_workspace_status` | Refresh one workspace by its opaque UUID. |
| `cmux_surface_tail` | Read at most 200 lines from a verified Pi-paired terminal. |
| `cmux_pi_prompt` | Submit a single-line prompt only when the paired live Pi process is idle. |
| `cmux_pi_steer` | Submit single-line steering only while the paired Pi process is running. |
| `cmux_pi_abort` | Send Ctrl-C only to a verified running Pi surface. |
| `cmux_workspace_focus` | Focus a currently existing workspace on the laptop. |

Mutating tools fail closed when the workspace/surface mapping is stale, ambiguous, not a terminal, not paired by the cmux Pi extension, or no longer owned by a live Pi process. Prompt text and terminal output are content-redacted from relay audit receipts.

## Code Mode

`machinectl` exposes a small underlying computer capability set. Code Mode is a natural higher-level interface for clients that support it: a client can expose one isolated `code` tool that orchestrates `shell`, desktop controls and `harness_*` operations without repeated model/tool round trips.

That orchestration layer belongs in the authenticated client or relay. The daemon deliberately remains a simple, inspectable computer-control backend.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `MACHINECTL_URL` | required | URL of your trusted compatible Worker relay. |
| `MACHINECTL_NAME` | hostname | Machine name published to the relay. |
| `MACHINECTL_ACCESS_TOKEN` | unset | Explicit token override instead of retrieving an Access token through `cloudflared`. |
| `MACHINECTL_ALLOWED_PATHS` | empty | Permitted `shell.cwd` roots, the default shell working directory, and optional pi project/session roots. |
| `MACHINECTL_ENABLE_SHELL` | off | Publishes the terminal-equivalent `shell` tool. |
| `MACHINECTL_SHELL_ENV_PASSTHROUGH` | empty | Extra environment variable names a shell command may read. |
| `MACHINECTL_SHELL_TIMEOUT` | `60000` | Default shell timeout in milliseconds. |
| `MACHINECTL_SCREENSHOT_MAX_BYTES` | `8388608` | Maximum encoded image bytes returned from a screenshot. |
| `MACHINECTL_SCREENSHOT_DEFAULT_MAX_WIDTH` | `1440` | Default maximum width for preview screenshots. |
| `MACHINECTL_SCREENSHOT_DEFAULT_QUALITY` | `68` | Default JPEG quality for preview screenshots. |
| `MACHINECTL_STATE_DIR` | `~/.local/state` | The directory for the single instance lock. `XDG_STATE_HOME` also sets it. |
| `MACHINECTL_LOG_TIMING` | unset | Set to `1` to log bounded local screenshot and persisted-session timing diagnostics. |
| `MACHINECTL_PI_PERSISTED_CACHE_MS` | `10000` | Cache lifetime for explicit persisted Pi-session discovery. |
| `MACHINECTL_ENABLE_PI` | unset | Set to `1` or `true` to publish the Pi adapter and deprecated `pi_*` aliases. |
| `MACHINECTL_ENABLE_ACP` | unset | Set to `1` or `true` to publish the Agent Client Protocol adapters. |
| `MACHINECTL_ACP_AGENTS` | `opencode` | The ACP agents to publish, with a comma between each agent: `opencode`, `claude`, `codex`, `amp`, `gemini`, or your own identifier. |
| `MACHINECTL_ACP_COMMAND_<ID>` | supplied | The launch command for one ACP agent, for example `MACHINECTL_ACP_COMMAND_CODEX`. |
| `MACHINECTL_ACP_PERMISSION` | `deny` | The answer to `session/request_permission`: `deny`, `ask`, or `allow`. |
| `MACHINECTL_ACP_PERMISSION_TIMEOUT_MS` | `120000` | The time that an `ask` request waits for a user. After this time, machinectl refuses the request. |
| `MACHINECTL_ACP_MODE` | unset | The session mode to use. If you do not set it, machinectl uses the mode that has the fewest permissions. |
| `MACHINECTL_ACP_HANDSHAKE_TIMEOUT_MS` | `60000` | The time limit for `initialize`, `session/new`, and `session/set_mode`. |
| `MACHINECTL_ACP_PROMPT_TIMEOUT_MS` | `300000` | The time limit for one `session/prompt` operation. |
| `MACHINECTL_ENABLE_CMUX` | unset | Set to `1` or `true` to publish narrow controls for existing cmux/Pi workspaces. |
| `MACHINECTL_CMUX_BIN` | `cmux` | The path to the cmux CLI. machinectl calls it directly, without a shell. |
| `MACHINECTL_CMUX_PI_SESSION_STORE` | `~/.cmuxterm/pi-hook-sessions.json` | Override the cmux Pi pairing store path, primarily for tests. |
| `MACHINECTL_CMUX_PASSWORD_FILE` | unset | The local file with mode `0600` that contains the cmux socket secret. machinectl does not send this secret to the relay. |
| `MACHINECTL_PI_MAX_SESSIONS` | `4` | Maximum concurrently active pi RPC sessions. |
| `MACHINECTL_PI_MAX_RUNTIME_MS` | `7200000` | Maximum lifetime of a tracked pi process. |
| `MACHINECTL_PI_STOP_GRACE_MS` | `5000` | Grace period before force-killing a stopped pi process group. |

## One daemon for each identity

Two daemons that use one `MACHINECTL_NAME` and one relay are a failure mode that is difficult to see. The relay keeps one connection for each machine identity. Each new daemon thus removes the other daemon. The two daemons then reconnect again and again. Your calls go to one daemon or the other daemon, and you cannot control which one.

The result is worse than a stopped daemon. If the two daemons have different configurations, each one gives a different list of tools. A tool such as `cmux_workspace_list` is then available for some calls and absent for other calls. No error message shows the cause.

machinectl thus gets a lock at start. The lock is one file in `MACHINECTL_STATE_DIR`. The name of the file comes from the machine name and the relay URL:

- If a live daemon holds the identity, the new daemon writes the process identifier of that daemon and stops with exit code 1.
- If the daemon that holds the lock is dead, the new daemon removes the old lock and continues. A restart after a crash or a power failure thus needs no manual work.
- A different `MACHINECTL_NAME`, or a different relay, gets a different lock. You can operate a development daemon and a production daemon at the same time.

To find a daemon that has your identity, use `pgrep -f dist/index.js`. Then compare the result with `launchctl list` on macOS.

## Security model

An authenticated MCP caller controls your computer:

- `shell` gives the same access as a terminal for your local user. It is off until you set `MACHINECTL_ENABLE_SHELL`.
- `screenshot` can show private information.
- `mouse` and `keyboard` can operate applications that have a login.
- The `harness_*` tools can read and control the content of a local agent session.
- The optional `cmux_*` tools can read recent Pi terminal output. They control only a Pi surface that machinectl verifies locally.
- `local_auth_status` shows only short diagnostic data. It shows no credentials.

The included relay example:

- It authenticates each call through Cloudflare Access.
- It keeps one connected computer for each authenticated identity.
- It limits the size of the catalog, the request, the result, and the data in transfer.
- It can store short audit records. The records contain no tool output.

### What the shell controls do

| Control | What it does | What it does not do |
| --- | --- | --- |
| `MACHINECTL_ENABLE_SHELL` | Withholds `shell` until you set it. | It does not limit a command after you enable the tool. |
| `MACHINECTL_ALLOWED_PATHS` | Sets the working directory, and refuses a `cwd` outside the roots. | It does not stop a command that names an absolute path. |
| `MACHINECTL_SHELL_ENV_PASSTHROUGH` | Allows selected extra variables, except `MACHINECTL_ACCESS_TOKEN`, into the command's direct environment. | It does not stop a command that reads a credential file or, on Linux, a same-user process environment through `/proc`. |

These controls bound the path and the directly inherited environment. They are not a sandbox. A command runs with the file permissions of your user.

Do not use this relay for work that needs container isolation. Do not use it for work that needs read-only operation. Refer to [SECURITY.md](./SECURITY.md).

## Development

```bash
npm install
npm run typecheck
npm test
npm run dev
```

You can test the basic relay example separately:

```bash
cd examples/cloudflare-worker-relay
npm install
npm test
```

To run the thin Code Mode control page end to end locally:

```bash
cd examples/codemode-control
npm install
npm run dev:worker
```

Then, from the repository root in another terminal:

```bash
npm run build
MACHINECTL_URL=http://127.0.0.1:8789 \
MACHINECTL_ACCESS_TOKEN=dev \
MACHINECTL_NAME=local-mac \
MACHINECTL_ALLOWED_PATHS="$HOME/projects" \
MACHINECTL_ENABLE_PI=1 \
  node dist/index.js
```

Open `http://127.0.0.1:8789/`. See the example README for its private-deployment posture and Code Mode endpoint.

## License

MIT. See [LICENSE](./LICENSE).
