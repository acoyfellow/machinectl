# Cloudflare Worker relay example

Reference Worker endpoint for the `machinectl` laptop daemon. It provides:

- Cloudflare Access JWT verification in Worker code;
- a per-user `MachineHost` Durable Object;
- `GET /machinectl/connect` for the laptop WebSocket;
- `POST /machinectl/mcp` for MCP clients;
- `GET /machinectl/status` for authenticated status checks;
- bounded catalogs, request sizes, result sizes, and in-flight calls;
- optional content-minimizing KV audit receipts.

This example is intended as a starting point. Review its policy, retention, and machine-replacement behavior before exposing a shell-capable laptop daemon.

## Prerequisites

- Cloudflare account with Workers, Durable Objects, and an Access application
- A hostname you control, e.g. `machinectl.example.com`
- Node.js 20+
- Wrangler authentication for deployment

## 1. Install

```bash
cd examples/cloudflare-worker-relay
npm install
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc`:

- replace `machinectl.example.com` with your hostname;
- replace `CF_ACCESS_AUD` with your Access application audience tag;
- replace `CF_ACCESS_ISS` with your Access team issuer;
- optionally replace the `AUDIT_KV` namespace id, or remove the KV binding to disable persistent receipts.

## 2. Configure Cloudflare Access

Create a Cloudflare Access self-hosted application for your relay hostname. Its policy controls who can:

- connect a laptop daemon;
- list tools;
- invoke laptop tools through MCP.

The Worker also verifies `Cf-Access-Jwt-Assertion` against your configured issuer and audience before routing any `/machinectl/*` request.

## 3. Deploy

```bash
npm run typecheck
npm run deploy
```

Your relay endpoints will be:

```text
GET  https://machinectl.example.com/machinectl/connect
POST https://machinectl.example.com/machinectl/mcp
GET  https://machinectl.example.com/machinectl/status
```

All three routes require a valid Access identity. `/health` is intentionally a non-sensitive liveness endpoint.

## 4. Connect the laptop daemon

From the repository root:

```bash
npm install
npm run build

export MACHINECTL_URL=https://machinectl.example.com
cloudflared access login "$MACHINECTL_URL"

MACHINECTL_ALLOWED_PATHS=/Users/you/projects \
  node dist/index.js
```

## Relay behavior

### Machine routing

A `MachineHost` Durable Object is selected by the authenticated user's email. One active laptop connection is supported per user; a newer connection replaces the previous connection.

### Bounds

The example limits:

| Resource | Limit |
|---|---:|
| Published tools | 64 |
| Published catalog JSON | 128 KB |
| MCP request body | 128 KB |
| Relayed result content | 512 KB |
| Concurrent in-flight laptop calls per user | 8 |
| Tool-call relay timeout | 60 seconds |

Adjust these limits to fit your deployment.

### Audit receipts

If `AUDIT_KV` is configured, the relay writes an identity-keyed post-call receipt with a 30-day TTL. The example intentionally does **not** store returned content and stores only selected low-risk argument metadata for known tools. Other argument fields are represented by key names, byte length, and a redaction indicator.

Receipts are written after execution. A receipt storage failure is logged but does not convert a completed laptop operation into a failed MCP result.

### Security considerations

- The daemon exposes `exec_command`, which is shell-equivalent by design.
- The daemon's current `git` tool is also shell-equivalent; do not treat it as constrained execution.
- Anyone authorized by your Access policy can invoke tools on the connected laptop.
- A new daemon connection for the same user replaces the previous connection.
- Do not transmit secrets unless your end-to-end logging and retention policy is appropriate for them.
