# machinectl

Remote machine control for AI assistants.

MCP server that lets AI control your machine — anywhere, from any device. Full audit logging, real-time activity feed, and cross-platform tools. Works with Claude, GPT, and any MCP-compatible client.

## install

### option 1: download binary (easiest)

grab the latest release for your platform from [releases](https://github.com/acoyfellow/machinectl/releases):

```bash
# macos apple silicon
curl -L https://github.com/acoyfellow/machinectl/releases/latest/download/machinectl-macos-arm64 -o machinectl
chmod +x machinectl

# macos intel
curl -L https://github.com/acoyfellow/machinectl/releases/latest/download/machinectl-macos-x64 -o machinectl
chmod +x machinectl

# linux
curl -L https://github.com/acoyfellow/machinectl/releases/latest/download/machinectl-linux-x64 -o machinectl
chmod +x machinectl
```

### option 2: from source

```bash
git clone https://github.com/acoyfellow/machinectl
cd machinectl
bun install
bun run build
```

## quick start

just run it. tunnel starts automatically.

```bash
./machinectl
```

open `http://localhost:7331/ui` in your browser to see the tunnel URL and MCP endpoint.

**that's it.** one command, everything works.

## tunnel options

by default, machinectl starts a quick tunnel (random URL). customize with env vars:

### quick tunnel (default, random URL)

```bash
./machinectl
```

or explicitly:

```bash
MACHINECTL_TUNNEL= ./machinectl
```

### named tunnel (stable URL)

for a URL that never changes, set up a named tunnel with your own domain.

**1. install cloudflared**

```bash
# macos
brew install cloudflared

# linux
# see: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
```

**2. login to cloudflare**

```bash
cloudflared tunnel login
```

this opens a browser to authenticate. select the domain you want to use.

**3. create the tunnel**

```bash
cloudflared tunnel create machinectl
```

note the tunnel ID (e.g., `67b44024-1cdd-4bea-82a9-edecfe5d4829`).

**4. create config file**

create `~/.cloudflared/config.yml`:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /path/to/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: machinectl.yourdomain.com
    service: http://localhost:7331
  - service: http_status:404
```

replace:
- `YOUR_TUNNEL_ID` with your tunnel ID
- `machinectl.yourdomain.com` with your subdomain
- update the credentials-file path (usually `~/.cloudflared/YOUR_TUNNEL_ID.json`)

**5. add DNS record**

in cloudflare dashboard → DNS → Records:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | machinectl | YOUR_TUNNEL_ID.cfargotunnel.com | Proxied |

or via CLI:

```bash
cloudflared tunnel route dns machinectl machinectl.yourdomain.com
```

**6. run machinectl**

```bash
MACHINECTL_TUNNEL=machinectl ./machinectl
```

your stable URL is now `https://machinectl.yourdomain.com/mcp`.

### local only (no tunnel)

```bash
MACHINECTL_TUNNEL=false ./machinectl
```

useful for local development or when you're already behind a VPN/proxy.

see [cloudflare tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) for more details.

## connect to claude.ai

1. go to [claude.ai](https://claude.ai) → settings → integrations
2. click "add custom connector"
3. enter your URL: `https://your-tunnel-url/mcp`
4. click Add

done. now you can control your laptop from claude.ai on any device.

## tools

| tool | description | platform |
|------|-------------|----------|
| `screenshot` | Capture screen, returns base64-encoded PNG | macOS, Linux |
| `exec` | Run any shell command | All |
| `read_file` | Read file contents | All |
| `write_file` | Write to file (creates parent dirs) | All |
| `list_directory` | List files/dirs (optional recursion, max depth 3) | All |
| `git` | Run git commands | All |
| `clipboard` | Read or write system clipboard | macOS, Linux |
| `notify` | Send system notification | macOS, Linux |
| `processes` | List top processes by CPU or memory | All |

### Tool Examples

**screenshot**
```typescript
// No args - captures entire screen
screenshot()
```

**exec**
```typescript
exec({ command: "ls -la", cwd: "/Users/me/projects" })
```

**read_file**
```typescript
read_file({ path: "/Users/me/projects/app/package.json" })
```

**write_file**
```typescript
write_file({ path: "/tmp/test.txt", content: "Hello world" })
```

**list_directory**
```typescript
list_directory({ path: "/Users/me/projects", recursive: true })
```

**git**
```typescript
git({ args: "status", cwd: "/Users/me/projects/app" })
git({ args: 'commit -m "fix bug"' })
```

**clipboard**
```typescript
clipboard({ action: "read" })
clipboard({ action: "write", content: "Hello from AI" })
```

**notify**
```typescript
notify({ title: "Task Complete", message: "Your app is ready" })
```

**processes**
```typescript
processes({ sortBy: "cpu", limit: 10 })
processes({ sortBy: "memory", limit: 5 })
```

## use cases

### 1. "Spin up a new app" (Hero Use Case)

> Prompt: "Create a new remote app called wishlist and start the dev server"

Claude runs:
```bash
bun create remote-app wishlist
cd ~/wishlist
echo 'ALCHEMY_PASSWORD=generated-pw' > .env
echo 'BETTER_AUTH_SECRET=generated-secret' >> .env
bun install
bun dev
```

Returns: "Your app is running at http://localhost:5173 - SvelteKit + Better Auth + Durable Objects ready to go."

This is the money shot: Claude scaffolds YOUR preferred stack (not generic create-next-app), wires up secrets, starts the server. From your phone.

### 2. "What's using all my CPU?"

> Prompt: "What processes are using the most CPU on my machine?"

Claude uses the `processes` tool to identify resource hogs instantly.

### 3. "Commit my work"

> Prompt: "Look at my uncommitted changes and commit them with good messages"

Claude reads git status, analyzes diffs, groups related changes, writes meaningful commit messages, commits and pushes.

### 4. "Find that file"

> Prompt: "Find the Python script I wrote last week about parsing JSON"

Claude searches your projects using `list_directory` and `read_file`, finds matching files, shows you the path and preview.

### 5. "Fix my broken deploy"

> Prompt: "Take a screenshot, check the logs in ~/app/logs, and help me fix it"

Claude captures your screen, reads error logs, analyzes the issue, proposes fixes, applies them, redeploys.

## config

environment variables:

| var | description | default |
|-----|-------------|---------|
| `PORT` | server port | 7331 |
| `MACHINECTL_TOKEN` | bearer token for auth (optional) | disabled |
| `MACHINECTL_TUNNEL` | tunnel mode: unset=quick, `false`=disabled, `name`=named tunnel | quick tunnel |
| `MACHINECTL_ALLOWED_PATHS` | comma-separated allowed paths | `$HOME` |
| `MACHINECTL_ALLOWED_ORIGINS` | comma-separated CORS origins | `*.trycloudflare.com` |
| `EXEC_TIMEOUT` | command timeout in ms | 60000 |

example:

```bash
PORT=8080 MACHINECTL_ALLOWED_PATHS=/Users/me,/tmp ./machinectl
```

## api reference

### Dashboard

- `GET /ui` - Web dashboard with real-time activity feed
- `GET /health` - Health check endpoint

### Logs API

- `GET /api/logs?limit=50` - Get last N action logs (JSON)
- `GET /api/logs/stream` - SSE stream of new logs (real-time)
- `POST /api/logs/export` - Download full session as JSON

All actions are logged with:
- Tool name and arguments
- Result or error
- Duration
- Timestamp

## architecture

### Tool System

All tools are wrapped with `withLogging()` which:
- Records every action to in-memory log
- Broadcasts to SSE subscribers (dashboard)
- Tracks duration and errors
- Enables future persistence/webhooks/analytics

### Adding a New Tool

```typescript
mcpServer.registerTool("my_tool", {
  description: "What it does. Platform: macOS, Linux.",
  inputSchema: {
    arg1: z.string().describe("Description"),
  },
}, withLogging("my_tool", async ({ arg1 }) => {
  // Your implementation
  return text("Success");
}));
```

The `withLogging` wrapper automatically:
- Logs the action
- Handles errors
- Broadcasts to dashboard
- Tracks performance

### Platform Detection

Tools detect platform via `os.platform()`:
- `"darwin"` - macOS
- `"linux"` - Linux
- Graceful degradation for unsupported platforms

### Extension Points

- **Action logs**: Can be persisted to file/DB, sent to webhooks, analyzed
- **SSE infrastructure**: Enables mobile companion, multi-client dashboards
- **Tool middleware**: Rate limiting, approval workflows, custom validation
- **Platform detection**: Windows support, container detection, SSH remoting

## security

machinectl gives full access to your machine within allowed paths. keep your tunnel URL private.

- File operations restricted to `MACHINECTL_ALLOWED_PATHS` (default: home directory)
- Optional bearer token auth via `MACHINECTL_TOKEN` (in URL path)
- CORS restricted to tunnel domains by default
- All actions logged and visible in dashboard
- Session export available for audit trails

## requirements

- macos or linux (for screenshot)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) installed (auto-starts tunnel, or set `MACHINECTL_TUNNEL=false` to disable)

## dev

```bash
bun install
bun dev          # run with watch mode
bun run build    # compile binary
bun run build:all # compile for all platforms
```

### Project Structure

- `src/index.ts` - Main server file (single file, ~850 lines)
  - MCP server setup
  - Tool definitions
  - Hono HTTP server
  - Dashboard UI
  - Logging system

### Contributing

To add a new tool:

1. Define the tool schema with Zod
2. Wrap handler with `withLogging(toolName, handler)`
3. Add platform detection if needed
4. Update README tools table
5. Add example to use cases section

## license

MIT
