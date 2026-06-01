import { DurableObject } from "cloudflare:workers";

export interface PublishedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type LaptopFrame =
  | { type: "hello"; machineName: string; tools: PublishedTool[] }
  | { type: "result"; id: string; ok: true; content: string }
  | { type: "result"; id: string; ok: false; error: string }
  | { type: "pong" };

type ToolResult = { ok: true; content: string } | { ok: false; error: string };
type HostEnv = { AUDIT_KV?: KVNamespace };
type SocketAttachment = { generation: string; connectedAt: number };
type InternalIdentity = { email: string; sub: string };
type PendingCall = {
  resolve: (value: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

const TOOL_LIMIT = 64;
const CATALOG_BYTE_LIMIT = 128 * 1024;
const ARGS_BYTE_LIMIT = 128 * 1024;
const RESULT_BYTE_LIMIT = 512 * 1024;
const MAX_PENDING_CALLS = 8;
const CALL_TIMEOUT_MS = 60_000;
const RECEIPT_TTL_SECONDS = 60 * 60 * 24 * 30;
const MACHINE_NAME = "machineName";
const TOOLS = "tools";
const GENERATION = "generation";

function byteLength(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

function safeText(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  return value.slice(0, maxBytes) + "\n... (truncated by relay)";
}

function validateTools(tools: unknown): tools is PublishedTool[] {
  if (!Array.isArray(tools) || tools.length > TOOL_LIMIT || byteLength(tools) > CATALOG_BYTE_LIMIT) return false;
  return tools.every((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const value = tool as Record<string, unknown>;
    return typeof value.name === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value.name) &&
      typeof value.description === "string" && value.description.length <= 2_000 &&
      !!value.inputSchema && typeof value.inputSchema === "object";
  });
}

function mcpResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function mcpError(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function summarizeArgs(tool: string, args: Record<string, unknown>) {
  const allowedKeys = tool === "shell"
    ? ["cwd", "timeoutMs"]
    : tool === "mouse"
      ? ["action", "x", "y", "delta"]
      : tool === "pi_start"
        ? ["cwd", "model", "thinking", "continueRecent"]
        : tool === "pi_status" || tool === "pi_stop" || tool === "pi_abort" || tool === "pi_command"
          ? ["id", "command"]
          : [];
  const summary: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in args) summary[key] = args[key];
  }
  return {
    keys: Object.keys(args),
    byteLength: byteLength(args),
    safe: summary,
    contentRedacted: Object.keys(args).some((key) => !allowedKeys.includes(key)),
  };
}

export class MachineHost extends DurableObject<HostEnv> {
  private readonly pending = new Map<string, PendingCall>();

  private socket() {
    return this.ctx.getWebSockets("laptop")[0] ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/connect") return this.acceptConnection(request);
    if (path === "/mcp") return this.mcp(request);
    if (path === "/status") {
      const connected = this.socket() !== null;
      return Response.json({
        connected,
        machineName: connected ? (await this.ctx.storage.get<string>(MACHINE_NAME)) ?? null : null,
        tools: connected ? (await this.ctx.storage.get<PublishedTool[]>(TOOLS)) ?? [] : [],
      });
    }
    return new Response("not found", { status: 404 });
  }

  private identity(request: Request): InternalIdentity {
    const email = request.headers.get("X-Machinectl-Identity-Email");
    const sub = request.headers.get("X-Machinectl-Identity-Sub");
    if (!email || !sub) throw new Error("verified identity not provided by relay route");
    return { email, sub };
  }

  private async acceptConnection(request: Request): Promise<Response> {
    const identity = this.identity(request);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const generation = crypto.randomUUID();
    for (const socket of this.ctx.getWebSockets("laptop")) {
      try { socket.close(1012, "replaced by a new machine connection"); } catch { /* no-op */ }
    }
    await this.ctx.storage.put({ [GENERATION]: generation, identity: identity.email });
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ generation, connectedAt: Date.now() } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(pair[1], ["laptop"]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
    let frame: LaptopFrame;
    try {
      frame = JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)) as LaptopFrame;
    } catch {
      socket.close(1003, "invalid json frame");
      return;
    }
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const generation = await this.ctx.storage.get<string>(GENERATION);
    if (!attachment?.generation || attachment.generation !== generation) return;
    if (frame.type === "hello") {
      if (frame.machineName.length > 128 || !validateTools(frame.tools)) {
        socket.close(1008, "invalid tool catalog");
        return;
      }
      await this.ctx.storage.put({ [MACHINE_NAME]: frame.machineName, [TOOLS]: frame.tools });
      return;
    }
    if (frame.type === "result") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.ok) pending.resolve({ ok: true, content: safeText(frame.content, RESULT_BYTE_LIMIT) });
      else pending.resolve({ ok: false, error: safeText(frame.error, 8_192) });
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const generation = await this.ctx.storage.get<string>(GENERATION);
    if (attachment?.generation !== generation) return;
    await this.ctx.storage.delete([GENERATION, MACHINE_NAME, TOOLS]);
    this.failPending("machine disconnected during tool call");
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }

  private failPending(error: string) {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      this.pending.delete(id);
      call.resolve({ ok: false, error });
    }
  }

  private async mcp(request: Request): Promise<Response> {
    const identity = this.identity(request);
    if (request.method !== "POST") return new Response("POST required", { status: 405 });
    const bodyText = await request.text();
    if (byteLength(bodyText) > ARGS_BYTE_LIMIT) return new Response("request too large", { status: 413 });
    let body: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try { body = JSON.parse(bodyText) as typeof body; } catch { return mcpError(null, -32700, "parse error"); }
    if (body.method === "initialize") {
      return mcpResult(body.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "machinectl-relay", version: "0.1.0" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 204 });
    if (body.method === "ping") return mcpResult(body.id, {});
    const tools = this.socket() ? (await this.ctx.storage.get<PublishedTool[]>(TOOLS)) ?? [] : [];
    if (body.method === "tools/list") return mcpResult(body.id, { tools });
    if (body.method !== "tools/call") return mcpError(body.id, -32601, "method not found");
    const tool = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (!tool || !tools.some((entry) => entry.name === tool)) {
      return mcpResult(body.id, textResult(`tool not available: ${tool ?? "missing"}`, true));
    }
    if (this.pending.size >= MAX_PENDING_CALLS) {
      return mcpResult(body.id, textResult("machine busy: too many in-flight calls", true));
    }
    const result = await this.call(tool, args);
    await this.writeReceipt(identity, tool, args, result).catch((error) => console.error("machinectl_receipt_failed", error));
    return mcpResult(body.id, result.ok ? textResult(result.content) : textResult(result.error, true));
  }

  private call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const socket = this.socket();
    if (!socket) return Promise.resolve({ ok: false, error: "no machine connected" });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "machine tool call timed out" });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      socket.send(JSON.stringify({ type: "call", id, tool, args }));
    });
  }

  private async writeReceipt(identity: InternalIdentity, tool: string, args: Record<string, unknown>, result: ToolResult): Promise<void> {
    if (!this.env.AUDIT_KV) return;
    const receipt = {
      schema: "machinectl.audit-receipt.v1",
      timestamp: new Date().toISOString(),
      identity: identity.email,
      tool,
      request: summarizeArgs(tool, args),
      result: {
        ok: result.ok,
        byteLength: byteLength(result.ok ? result.content : result.error),
        contentStored: false,
      },
    };
    await this.env.AUDIT_KV.put(`machinectl:${identity.email}:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify(receipt), { expirationTtl: RECEIPT_TTL_SECONDS });
  }
}
