import { DurableObject } from "cloudflare:workers";
import { byteLength, sanitizeSuccessResult, safeText, summarizeArgs, validateTools, type PublishedTool, type ToolResult } from "./policy";

export type { PublishedTool } from "./policy";

type LaptopFrame =
  | { type: "hello"; machineName: string; tools: PublishedTool[] }
  | { type: "result"; id: string; ok: true; content: string; metrics?: { toolExecMs?: number; resultBytes?: number } }
  | { type: "result"; id: string; ok: false; error: string; metrics?: { toolExecMs?: number; resultBytes?: number } }
  | { type: "ping" }
  | { type: "pong" };

type HostEnv = { AUDIT_KV?: KVNamespace };
type SocketAttachment = { generation: string; connectedAt: number };
type InternalIdentity = { email: string; sub: string };
type PendingCall = { resolve: (value: ToolResult) => void; timer: ReturnType<typeof setTimeout>; dispatchedAt: number };

const ARGS_BYTE_LIMIT = 128 * 1024;
const MAX_PENDING_CALLS = 8;
const CALL_TIMEOUT_MS = 60_000;
const RECEIPT_TTL_SECONDS = 60 * 60 * 24 * 30;
const MACHINE_NAME = "machineName";
const TOOLS = "tools";
const GENERATION = "generation";

function mcpResult(id: unknown, result: unknown) { return Response.json({ jsonrpc: "2.0", id: id ?? null, result }); }
function mcpError(id: unknown, code: number, message: string) { return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }); }
function textResult(value: string, isError = false) { return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) }; }

export class MachineHost extends DurableObject<HostEnv> {
  private readonly pending = new Map<string, PendingCall & { tool: string }>();
  private cachedMachineName?: string;
  private cachedTools?: PublishedTool[];

  private socket(): WebSocket | null {
    return this.ctx.getWebSockets("laptop")
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .sort((a, b) => ((b.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? 0) - ((a.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? 0))[0] ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/connect") return this.acceptConnection(request);
    if (path === "/mcp") return this.mcp(request);
    if (path === "/call") return this.directCall(request);
    if (path === "/status") {
      const connected = this.socket() !== null;
      const [machineName, tools] = connected ? await Promise.all([this.machineName(), this.tools()]) : [null, []];
      return Response.json({ connected, machineName, tools });
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
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const generation = crypto.randomUUID();
    this.failPending("machine connection replaced during tool call");
    for (const socket of this.ctx.getWebSockets("laptop")) { try { socket.close(1012, "replaced by a new machine connection"); } catch {} }
    this.cachedMachineName = undefined;
    this.cachedTools = undefined;
    await this.ctx.storage.put({ [GENERATION]: generation, identity: identity.email });
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ generation, connectedAt: Date.now() } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(pair[1], ["laptop"]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
    let frame: LaptopFrame;
    try { frame = JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)) as LaptopFrame; } catch { socket.close(1003, "invalid json frame"); return; }
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const generation = await this.ctx.storage.get<string>(GENERATION);
    if (!attachment?.generation || attachment.generation !== generation) return;
    if (frame.type === "hello") {
      if (frame.machineName.length > 128 || !validateTools(frame.tools)) { socket.close(1008, "invalid tool catalog"); return; }
      this.cachedMachineName = frame.machineName;
      this.cachedTools = frame.tools;
      await this.ctx.storage.put({ [MACHINE_NAME]: frame.machineName, [TOOLS]: frame.tools }); return;
    }
    if (frame.type === "ping") { socket.send(JSON.stringify({ type: "pong" })); return; }
    if (frame.type === "result") {
      const pending = this.pending.get(frame.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(frame.id);
      console.log("machinectl_tool_timing", { tool: pending.tool, roundTripMs: Date.now() - pending.dispatchedAt, toolExecMs: frame.metrics?.toolExecMs ?? null, resultBytes: frame.metrics?.resultBytes ?? (frame.ok ? byteLength(frame.content) : byteLength(frame.error)) });
      pending.resolve(frame.ok ? sanitizeSuccessResult(pending.tool, frame.content) : { ok: false, error: safeText(frame.error, 8_192) });
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const generation = await this.ctx.storage.get<string>(GENERATION);
    if (attachment?.generation !== generation) return;
    this.cachedMachineName = undefined; this.cachedTools = undefined;
    await this.ctx.storage.delete([GENERATION, MACHINE_NAME, TOOLS]); this.failPending("machine disconnected during tool call");
  }
  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket); }
  private failPending(error: string) { for (const [id, call] of this.pending) { clearTimeout(call.timer); this.pending.delete(id); call.resolve({ ok: false, error }); } }
  private async tools(): Promise<PublishedTool[]> { return this.cachedTools ??= (await this.ctx.storage.get<PublishedTool[]>(TOOLS)) ?? []; }
  private async machineName(): Promise<string | null> { this.cachedMachineName ??= (await this.ctx.storage.get<string>(MACHINE_NAME)) ?? undefined; return this.cachedMachineName ?? null; }

  private async directCall(request: Request): Promise<Response> {
    const identity = this.identity(request);
    const bodyText = await request.text(); if (byteLength(bodyText) > ARGS_BYTE_LIMIT) return new Response("request too large", { status: 413 });
    let body: { tool?: string; arguments?: Record<string, unknown> }; try { body = JSON.parse(bodyText) as typeof body; } catch { return Response.json({ ok: false, error: "parse error" }, { status: 400 }); }
    if (!body.tool) return Response.json({ ok: false, error: "tool is required" }, { status: 400 });
    const result = await this.invokeTool(body.tool, body.arguments ?? {});
    this.ctx.waitUntil(this.writeReceipt(identity, body.tool, body.arguments ?? {}, result).catch((error) => console.error("machinectl_receipt_failed", error)));
    return Response.json(result);
  }

  private async mcp(request: Request): Promise<Response> {
    const identity = this.identity(request); const bodyText = await request.text();
    if (byteLength(bodyText) > ARGS_BYTE_LIMIT) return new Response("request too large", { status: 413 });
    let body: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }; try { body = JSON.parse(bodyText) as typeof body; } catch { return mcpError(null, -32700, "parse error"); }
    if (body.method === "initialize") return mcpResult(body.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "machinectl-direct", version: "0.1.0" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 204 });
    if (body.method === "ping") return mcpResult(body.id, {});
    const tools = this.socket() ? await this.tools() : [];
    if (body.method === "tools/list") return mcpResult(body.id, { tools });
    if (body.method !== "tools/call") return mcpError(body.id, -32601, "method not found");
    const tool = body.params?.name; if (!tool) return mcpResult(body.id, textResult("tool not available: missing", true));
    const args = body.params?.arguments ?? {}; const result = await this.invokeTool(tool, args);
    this.ctx.waitUntil(this.writeReceipt(identity, tool, args, result).catch((error) => console.error("machinectl_receipt_failed", error)));
    return mcpResult(body.id, result.ok ? textResult(result.content) : textResult(result.error, true));
  }

  private async invokeTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tools = this.socket() ? await this.tools() : [];
    if (!tools.some((entry) => entry.name === tool)) return { ok: false, error: `tool not available: ${tool}` };
    if (this.pending.size >= MAX_PENDING_CALLS) return { ok: false, error: "machine busy: too many in-flight calls" };
    const socket = this.socket(); if (!socket) return { ok: false, error: "no machine connected" };
    const id = crypto.randomUUID();
    return new Promise((resolve) => { const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: "machine tool call timed out" }); }, CALL_TIMEOUT_MS); this.pending.set(id, { resolve, timer, tool, dispatchedAt: Date.now() }); socket.send(JSON.stringify({ type: "call", id, tool, args })); });
  }

  private async writeReceipt(identity: InternalIdentity, tool: string, args: Record<string, unknown>, result: ToolResult): Promise<void> {
    if (!this.env.AUDIT_KV) return;
    const receipt = { schema: "machinectl.audit-receipt.v1", timestamp: new Date().toISOString(), identity: identity.email, tool, request: summarizeArgs(tool, args), result: { ok: result.ok, byteLength: byteLength(result.ok ? result.content : result.error), contentStored: false } };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity.email));
    const principal = Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await this.env.AUDIT_KV.put(`machinectl:${principal}:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify(receipt), { expirationTtl: RECEIPT_TTL_SECONDS });
  }
}
