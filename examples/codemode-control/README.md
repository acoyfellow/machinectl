# Code Mode control client example

A minimal private control page and Code Mode-first MCP relay for `machinectl`.

The included UI uses Fragment Mono throughout. The font is bundled under the SIL Open Font License; its license text is included alongside the font file.

This is a second client implementation alongside any product integration: it is designed to be run locally for proof, or privately deployed behind **your own** Cloudflare Access policy. It is not a public demo site.

## What it includes

- one Access-gated browser control page;
- a per-user `MachineHost` Durable Object for the outbound laptop connection;
- `POST /mcp`, which exposes one isolated Code Mode `code` tool;
- optional `POST /mcp/direct`, a raw direct-tools compatibility/debug endpoint enabled in local dev and disabled in production unless explicitly configured;
- direct status/screenshot/shell proof controls for a human operator, subject to the same direct-tools switch;
- Worker Loader-backed `DynamicWorkerExecutor` with ambient outbound networking disabled.

```text
browser or MCP agent
       │ authenticated in production / local bypass in dev
       ▼
Worker + Static Assets + Code Mode
       │
MachineHost Durable Object
       │ outbound WebSocket
       ▼
machinectl daemon on your computer
```

> `shell` remains terminal-equivalent. Code Mode isolates generated orchestration code; it does not reduce the authority deliberately granted to the connected laptop.

## Local end-to-end demo

### 1. Build the daemon

From the `machinectl` repository root:

```bash
npm install
npm run build
```

### 2. Start this local client Worker

In another terminal:

```bash
cd examples/codemode-control
npm install
npm run dev:worker
```

Local configuration in `wrangler.local.jsonc` explicitly enables a development-only authentication bypass for `dev@machinectl.local`. The Worker refuses that bypass unless both `MACHINECTL_ENV=development` and a loopback request hostname are present. Do not use that config for production deployment.

### 3. Connect a local daemon

From the `machinectl` repository root, in another terminal:

```bash
MACHINECTL_URL=http://127.0.0.1:8789 \
MACHINECTL_ACCESS_TOKEN=dev \
MACHINECTL_NAME=local-mac \
MACHINECTL_ALLOWED_PATHS="$HOME/projects" \
MACHINECTL_ENABLE_PI=1 \
  node dist/index.js
```

### 4. Open the operator page

```text
http://127.0.0.1:8789/
```

You should see the laptop marked online. Try:

- **Auth health**
- **Screenshot**
- the direct shell proof field
- **Execute isolated code**

### 5. Verify the Code Mode MCP endpoint

`/mcp` should advertise only `code`:

```bash
curl -X POST http://127.0.0.1:8789/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Execute a Code Mode proof through the page or with:

```bash
curl -X POST http://127.0.0.1:8789/api/code \
  -H 'content-type: application/json' \
  -d '{"code":"async () => { return await codemode.shell({ command: \"printf CODEMODE_OK\" }); }"}'
```

## Private deployment shape

If you deploy this example, copy `wrangler.jsonc.example` to `wrangler.jsonc`, configure a hostname and Access application you control, set `MACHINECTL_ALLOWED_EMAILS` to the explicit comma-separated operator identities allowed to use it, and protect **all application routes** with your Access policy. The app's Worker independently verifies both the Access JWT and this operator allowlist before serving the UI, MCP endpoints, status/control routes, or laptop socket. `wrangler.jsonc.example` sets `MACHINECTL_ENV=production` and does not contain the local authentication bypass.

Security posture:

- `shell` is terminal-equivalent and the UI offers it only after authentication;
- generated Code Mode runs with ambient outbound networking disabled, but can still intentionally invoke authorized laptop tools;
- normal text results are bounded; screenshot data URLs are accepted only as validated raster data and capped at 12 MB for browser display;
- optional audit receipts redact shell commands, typed text, prompts, and result content, and KV keys use a hashed operator identifier;
- production defaults to the Code Mode `/mcp` interface; to deliberately enable equally privileged direct controls for operator debugging, set `MACHINECTL_ALLOW_DIRECT_TOOLS=1`.
- optionally set `MACHINECTL_LOCATION_HINT` before a user's `MachineHost` is first created to place its durable bridge near the laptop's usual region (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`, or `sam`). It is best-effort and does not relocate an existing object.
- screenshots default to compressed preview-friendly output from current daemons; request `format: "png", fullResolution: true` only when exact pixels are required.

Never host an operator instance publicly or attach a laptop to an unauthenticated deployment.
