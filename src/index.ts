#!/usr/bin/env node
// index.ts — machinectl laptop daemon.
//
// Connects (outbound) to the Worker-side MachineHost DO via WebSocket,
// publishes its tool catalog on `hello`, and serves `call` frames by
// dispatching to local tools defined in tools.ts.
//
// No inbound port. No public tunnel. No bearer-token-as-URL.
//
// ─── auth model ──────────────────────────────────────────────────────────
//
// When the configured /machinectl/connect endpoint is protected by
// Cloudflare Access, the daemon authenticates using a JWT acquired with
// `cloudflared access login` for MACHINECTL_URL. Specifically:
//
//   1. User runs `cloudflared access login "$MACHINECTL_URL"` once and gets
//      an Access JWT cached in ~/.cloudflared/.
//   2. The daemon calls `cloudflared access token --app=$MACHINECTL_URL` at
//      startup (and on reconnect) to obtain that JWT.
//   3. The JWT is sent as the `cf-access-token` header on the WS upgrade.
//      Access at the edge validates it and forwards the upgrade.
//
// If cloudflared isn't installed or the user hasn't logged in, the daemon
// emits a clear error pointing them at the right `cloudflared access login`
// invocation and exits.
//
// ─── reconnect policy ────────────────────────────────────────────────────
//
// Exponential backoff starting at 1s, capping at 30s. Reset to 1s after
// 60s of stable connection. Ctrl-C cleanly drains.

import WebSocket from "ws";
import { execSync } from "node:child_process";
import { hostname } from "node:os";
import { buildToolRegistry, FS_TOOLS_AVAILABLE } from "./tools.js";
import { shutdownAgentSessions } from "./agent-sessions.js";
import type { LaptopFrame, PublishedTool, RegisteredTool, WorkerFrame } from "./protocol.js";

// ─── config ──────────────────────────────────────────────────────────────
const URL_BASE = process.env.MACHINECTL_URL ?? "";
const MACHINE_NAME = process.env.MACHINECTL_NAME ?? hostname();
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const STABLE_CONNECTION_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

function log(...args: unknown[]) {
  // Prefix every line so it's obvious in mixed logs.
  console.log("[machinectl]", ...args);
}

function logErr(...args: unknown[]) {
  console.error("[machinectl]", ...args);
}

// ─── access token retrieval ──────────────────────────────────────────────

/** Pull the cached Cloudflare Access JWT for URL_BASE via cloudflared.
 *  Returns null if cloudflared isn't installed or the user hasn't
 *  logged in yet (so the caller can emit a friendly error). */
function getAccessToken(): string | null {
  // Explicit override for dev / CI.
  if (process.env.MACHINECTL_ACCESS_TOKEN) {
    return process.env.MACHINECTL_ACCESS_TOKEN;
  }
  try {
    const tok = execSync(`cloudflared access token --app=${URL_BASE}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return tok || null;
  } catch {
    return null;
  }
}

// ─── tool dispatch ───────────────────────────────────────────────────────

const REGISTRY: RegisteredTool[] = buildToolRegistry();

function publishedToolsFor(reg: RegisteredTool[]): PublishedTool[] {
  return reg.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchemaJson,
  }));
}

async function dispatchCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const t = REGISTRY.find((r) => r.name === toolName);
  if (!t) {
    return { ok: false, error: `Unknown tool: ${toolName}` };
  }
  // Validate args against Zod schema before invoking handler.
  const parsed = t.validator.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid args for ${toolName}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  try {
    const content = await t.handler(parsed.data);
    return { ok: true, content: typeof content === "string" ? content : String(content) };
  } catch (err) {
    return {
      ok: false,
      error: `${toolName}: ${(err as Error).message || String(err)}`,
    };
  }
}

// ─── connection loop ─────────────────────────────────────────────────────

let shuttingDown = false;
let currentBackoff = RECONNECT_MIN_MS;
let connectionStableTimer: NodeJS.Timeout | null = null;

async function connectOnce(): Promise<void> {
  if (!URL_BASE) {
    throw new Error("MACHINECTL_URL is required. Set it to your trusted compatible Worker endpoint, e.g. https://machinectl.example.com.");
  }
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error(
      `No Cloudflare Access token found for ${URL_BASE}.\n` +
        `Run:  cloudflared access login ${URL_BASE}\n` +
        `Or set MACHINECTL_ACCESS_TOKEN=... in the environment for testing.`,
    );
  }

  const wsUrl =
    URL_BASE.replace(/^http(s?):/, "ws$1:") + "/machinectl/connect";
  log(`connecting to ${wsUrl} as "${MACHINE_NAME}"`);

  const ws = new WebSocket(wsUrl, {
    headers: { "cf-access-token": accessToken },
    // 10s handshake timeout — fast failure beats waiting for TCP to give up.
    handshakeTimeout: 10_000,
  });

  return await new Promise<void>((resolve, reject) => {
    let resolved = false;
    function done(err?: Error) {
      if (resolved) return;
      resolved = true;
      if (err) reject(err);
      else resolve();
    }

    ws.on("open", () => {
      log("connected; publishing tool catalog");
      const hello: LaptopFrame = {
        type: "hello",
        machineName: MACHINE_NAME,
        tools: publishedToolsFor(REGISTRY),
      };
      ws.send(JSON.stringify(hello));
      // Mark the connection stable after STABLE_CONNECTION_MS without
      // a drop; that resets the backoff for next time.
      if (connectionStableTimer) clearTimeout(connectionStableTimer);
      connectionStableTimer = setTimeout(() => {
        currentBackoff = RECONNECT_MIN_MS;
      }, STABLE_CONNECTION_MS);
    });

    // Keep-alive pings from the daemon side. The Worker also pings;
    // either direction is fine. Hibernation-friendly: pongs come back
    // as plain ws control frames, which we don't need to handle here.
    const pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      try { ws.ping(); } catch {}
    }, PING_INTERVAL_MS);

    ws.on("message", async (data) => {
      let frame: WorkerFrame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // junk; drop
      }
      switch (frame.type) {
        case "call": {
          const result = await dispatchCall(frame.tool, frame.args);
          const out: LaptopFrame = result.ok
            ? { type: "result", id: frame.id, ok: true, content: result.content }
            : { type: "result", id: frame.id, ok: false, error: result.error };
          try {
            ws.send(JSON.stringify(out));
          } catch (err) {
            logErr("failed to send result:", err);
          }
          // Light per-call log so the user can see activity locally.
          log(
            `call ${frame.tool} → ${result.ok ? "ok" : "err"} (${
              result.ok ? result.content.length + "b" : result.error.slice(0, 60)
            })`,
          );
          return;
        }
        case "ping": {
          try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
          return;
        }
      }
    });

    ws.on("close", (code, reason) => {
      clearInterval(pingTimer);
      if (connectionStableTimer) {
        clearTimeout(connectionStableTimer);
        connectionStableTimer = null;
      }
      log(`disconnected (code ${code}, reason: ${reason?.toString() || "—"})`);
      done();
    });

    ws.on("error", (err) => {
      // Don't log noisy stack traces for routine failures; the surrounding
      // loop will reconnect with backoff.
      logErr(`socket error: ${err.message}`);
      // Don't done() here — the 'close' handler will fire right after.
    });
  });
}

async function runForever(): Promise<void> {
  while (!shuttingDown) {
    try {
      await connectOnce();
    } catch (err) {
      logErr((err as Error).message);
    }
    if (shuttingDown) break;
    log(`reconnecting in ${Math.round(currentBackoff / 1000)}s`);
    await new Promise((r) => setTimeout(r, currentBackoff));
    currentBackoff = Math.min(currentBackoff * 2, RECONNECT_MAX_MS);
  }
  log("shutting down");
}

// ─── startup ─────────────────────────────────────────────────────────────

function banner() {
  log(`machinectl daemon — machine: "${MACHINE_NAME}"`);
  log(`worker: ${URL_BASE}`);
  log(`tools registered: ${REGISTRY.map((t) => t.name).join(", ")}`);
  if (!FS_TOOLS_AVAILABLE) {
    log("[!] filesystem tools and agent session control (agent_*) are DISABLED");
    log("[!] set MACHINECTL_ALLOWED_PATHS=/abs/path1,/abs/path2 and restart to enable");
  }
}

process.on("SIGINT", () => {
  log("received SIGINT");
  shuttingDown = true;
  shutdownAgentSessions("machinectl received SIGINT");
});
process.on("SIGTERM", () => {
  log("received SIGTERM");
  shuttingDown = true;
  shutdownAgentSessions("machinectl received SIGTERM");
});

banner();
runForever().catch((err) => {
  logErr("fatal:", err);
  process.exit(1);
});
