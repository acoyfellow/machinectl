import { DurableObject } from "cloudflare:workers";
import { hasExpiredAccess } from "./auth";
import { byteLength, sanitizeSuccessResult, safeText, summarizeArgs, validateTools, type PublishedTool, type ToolResult } from "./policy";
import { readSocketStorageIfUnexpired, socketAttachmentExpired, type SocketAttachment } from "./socket-expiry";

export type { PublishedTool } from "./policy";

type LaptopFrame =
  | { type: "hello"; machineName: string; tools: PublishedTool[] }
  | { type: "result"; id: string; ok: true; content: string; metrics?: { toolExecMs?: number; resultBytes?: number } }
  | { type: "result"; id: string; ok: false; error: string; metrics?: { toolExecMs?: number; resultBytes?: number } }
  | { type: "ping" }
  | { type: "pong" };

type HostEnv = { AUDIT_KV?: KVNamespace };
type InternalIdentity = { email: string; sub: string; expiresAt: number };
type PendingCall = { resolve: (value: ToolResult) => void; timer: ReturnType<typeof setTimeout>; dispatchedAt: number };

const ARGS_BYTE_LIMIT = 128 * 1024;
const MAX_PENDING_CALLS = 8;
const CALL_TIMEOUT_MS = 60_000;
const RECEIPT_TTL_SECONDS = 60 * 60 * 24 * 30;
const MACHINE_NAME = "machineName";
const TOOLS = "tools";
const GENERATION = "generation";
const MACHINE_CONNECTION_EXPIRED = "connected machine identity has expired";

function mcpResult(id: unknown, result: unknown) { return Response.json({ jsonrpc: "2.0", id: id ?? null, result }); }
function mcpError(id: unknown, code: number, message: string) { return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }); }
function textResult(value: string, isError = false) { return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) }; }

export class MachineHost extends DurableObject<HostEnv> {
  private readonly pending = new Map<string, PendingCall & { tool: string }>();
  private cachedMachineName?: string;
  private cachedTools?: PublishedTool[];

  private latestOpenSocket(): WebSocket | null {
    return this.ctx.getWebSockets("laptop")
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .sort((a, b) => ((b.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? 0) - ((a.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? 0))[0] ?? null;
  }

  private socketExpired(attachment: SocketAttachment | null): boolean {
    return socketAttachmentExpired(attachment);
  }

  private expireSocket(socket: WebSocket): void {
    try { socket.close(1008, MACHINE_CONNECTION_EXPIRED); } catch {}
    this.failPending(MACHINE_CONNECTION_EXPIRED);
  }

  private socket(): WebSocket | null {
    const socket = this.latestOpenSocket();
    if (!socket) return null;
    if (this.socketExpired(socket.deserializeAttachment() as SocketAttachment | null)) {
      this.expireSocket(socket);
      return null;
    }
    return socket;
  }

  private socketStillLive(socket: WebSocket): boolean {
    if (!this.socketExpired(socket.deserializeAttachment() as SocketAttachment | null)) return true;
    this.expireSocket(socket);
    return false;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/connect") return this.acceptConnection(request);
    if (path === "/mcp") return this.mcp(request);
    if (path === "/call") return this.directCall(request);
    if (path === "/execution-receipt") return this.executionReceipt(request);
    if (path === "/status") {
      const socket = this.socket();
      if (!socket) return Response.json({ connected: false, machineName: null, tools: [] });
      const [machineName, tools] = await Promise.all([this.machineName(), this.tools()]);
      if (!this.socketStillLive(socket)) return Response.json({ connected: false, machineName: null, tools: [] });
      return Response.json({ connected: true, machineName, tools });
    }
    return new Response("not found", { status: 404 });
  }

  private identity(request: Request): InternalIdentity {
    const email = request.headers.get("X-Machinectl-Identity-Email");
    const sub = request.headers.get("X-Machinectl-Identity-Sub");
    const expiresAtHeader = request.headers.get("X-Machinectl-Identity-Expires");
    const expiresAt = Number(expiresAtHeader);
    if (!email || !sub || expiresAtHeader === null || !Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error("verified identity not provided by relay route");
    return { email, sub, expiresAt };
  }

  private async acceptConnection(request: Request): Promise<Response> {
    const identity = this.identity(request);
    if (hasExpiredAccess(identity.expiresAt)) return new Response(MACHINE_CONNECTION_EXPIRED, { status: 401 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const generation = crypto.randomUUID();
    this.failPending("machine connection replaced during tool call");
    for (const socket of this.ctx.getWebSockets("laptop")) { try { socket.close(1012, "replaced by a new machine connection"); } catch {} }
    this.cachedMachineName = undefined;
    this.cachedTools = undefined;
    await this.ctx.storage.put({ [GENERATION]: generation, identity: identity.email });
    if (hasExpiredAccess(identity.expiresAt)) return new Response(MACHINE_CONNECTION_EXPIRED, { status: 401 });
    await this.ctx.storage.setAlarm(identity.expiresAt * 1000);
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ generation, connectedAt: Date.now(), expiresAt: identity.expiresAt } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(pair[1], ["laptop"]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async alarm(): Promise<void> {
    const socket = this.latestOpenSocket();
    if (!socket) return;
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || this.socketExpired(attachment)) {
      this.expireSocket(socket);
      return;
    }
    await this.ctx.storage.setAlarm(attachment.expiresAt * 1000);
  }

  async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (this.socketExpired(attachment)) {
      this.expireSocket(socket);
      return;
    }
    let frame: LaptopFrame;
    try { frame = JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)) as LaptopFrame; } catch { socket.close(1003, "invalid json frame"); return; }
    const storageRead = await readSocketStorageIfUnexpired(attachment, () => this.ctx.storage.get<string>(GENERATION));
    if (storageRead.expired) {
      this.expireSocket(socket);
      return;
    }
    const generation = storageRead.value;
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
    const storageRead = await readSocketStorageIfUnexpired(attachment, () => this.ctx.storage.get<string>(GENERATION));
    if (storageRead.expired) {
      this.expireSocket(socket);
      return;
    }
    const generation = storageRead.value;
    if (attachment?.generation !== generation) return;
    this.cachedMachineName = undefined; this.cachedTools = undefined;
    await this.ctx.storage.delete([GENERATION, MACHINE_NAME, TOOLS]); this.failPending("machine disconnected during tool call");
  }
  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket); }
  private failPending(error: string) { for (const [id, call] of this.pending) { clearTimeout(call.timer); this.pending.delete(id); call.resolve({ ok: false, error }); } }
  private async tools(): Promise<PublishedTool[]> { return this.cachedTools ??= (await this.ctx.storage.get<PublishedTool[]>(TOOLS)) ?? []; }
  private async machineName(): Promise<string | null> { this.cachedMachineName ??= (await this.ctx.storage.get<string>(MACHINE_NAME)) ?? undefined; return this.cachedMachineName ?? null; }

  private async executionReceipt(request: Request): Promise<Response> {
    const identity = this.identity(request);
    const bodyText = await request.text();
    if (byteLength(bodyText) > ARGS_BYTE_LIMIT) return new Response("request too large", { status: 413 });
    let record: Record<string, unknown>;
    try { record = JSON.parse(bodyText) as Record<string, unknown>; } catch { return Response.json({ ok: false, error: "parse error" }, { status: 400 }); }
    this.ctx.waitUntil(this.writeExecutionReceipt(identity, record).catch((error) => console.error("machinectl_receipt_failed", error)));
    return Response.json({ ok: true });
  }

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
    const socket = this.socket();
    const tools = socket ? await this.tools() : [];
    if (socket && !this.socketStillLive(socket)) return mcpResult(body.id, { tools: [] });
    if (body.method === "tools/list") return mcpResult(body.id, { tools });
    if (body.method !== "tools/call") return mcpError(body.id, -32601, "method not found");
    const tool = body.params?.name; if (!tool) return mcpResult(body.id, textResult("tool not available: missing", true));
    const args = body.params?.arguments ?? {}; const result = await this.invokeTool(tool, args);
    this.ctx.waitUntil(this.writeReceipt(identity, tool, args, result).catch((error) => console.error("machinectl_receipt_failed", error)));
    return mcpResult(body.id, result.ok ? textResult(result.content) : textResult(result.error, true));
  }

  private async invokeTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const latestSocket = this.latestOpenSocket();
    if (latestSocket && this.socketExpired(latestSocket.deserializeAttachment() as SocketAttachment | null)) {
      this.expireSocket(latestSocket);
      return { ok: false, error: MACHINE_CONNECTION_EXPIRED };
    }
    const socket = this.socket();
    if (!socket) return { ok: false, error: "no machine connected" };
    const tools = await this.tools();
    if (!tools.some((entry) => entry.name === tool)) return { ok: false, error: `tool not available: ${tool}` };
    if (this.pending.size >= MAX_PENDING_CALLS) return { ok: false, error: "machine busy: too many in-flight calls" };
    if (!this.socketStillLive(socket)) return { ok: false, error: MACHINE_CONNECTION_EXPIRED };
    const id = crypto.randomUUID();
    return new Promise((resolve) => { const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: "machine tool call timed out" }); }, CALL_TIMEOUT_MS); this.pending.set(id, { resolve, timer, tool, dispatchedAt: Date.now() }); socket.send(JSON.stringify({ type: "call", id, tool, args })); });
  }

  private async writeExecutionReceipt(identity: InternalIdentity, record: Record<string, unknown>): Promise<void> {
    if (!this.env.AUDIT_KV) { this.warnAuditDisabled(); return; }
    const receipt = { schema: "machinectl.codemode-receipt.v1", timestamp: new Date().toISOString(), identity: identity.email, execution: record };
    await this.env.AUDIT_KV.put(`machinectl:codemode:${await this.principal(identity)}:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify(receipt), { expirationTtl: RECEIPT_TTL_SECONDS });
  }

  private async principal(identity: InternalIdentity): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity.sub));
    return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private auditWarningEmitted = false;
  private warnAuditDisabled(): void {
    if (this.auditWarningEmitted) return;
    this.auditWarningEmitted = true;
    console.warn("machinectl_audit_disabled", { reason: "AUDIT_KV is not bound; no receipt will be retained for any call on this machine channel" });
  }

  private async writeReceipt(identity: InternalIdentity, tool: string, args: Record<string, unknown>, result: ToolResult): Promise<void> {
    if (!this.env.AUDIT_KV) { this.warnAuditDisabled(); return; }
    const receipt = { schema: "machinectl.audit-receipt.v1", timestamp: new Date().toISOString(), identity: identity.email, tool, request: summarizeArgs(tool, args), result: { ok: result.ok, byteLength: byteLength(result.ok ? result.content : result.error), contentStored: false } };
    const principal = await this.principal(identity);
    await this.env.AUDIT_KV.put(`machinectl:${principal}:${Date.now()}:${crypto.randomUUID()}`, JSON.stringify(receipt), { expirationTtl: RECEIPT_TTL_SECONDS });
  }
}
