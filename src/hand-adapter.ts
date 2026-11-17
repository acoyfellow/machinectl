import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { RegisteredTool } from "./protocol.js";

export const HAND_TOOL_PREFIX = "hand_";
const HAND_CALL_TIMEOUT_MS = 55_000;

type JsonRpcMessage = { id?: number; result?: unknown; error?: { message?: string } };
type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
type McpContent = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

export function handBinary(): string | null {
  const explicit = process.env.MACHINECTL_HAND_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const bundled = "/Applications/hand.app/Contents/Resources/bin/hand";
  return existsSync(bundled) ? bundled : null;
}

export class HandClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private readonly waiting = new Map<number, { resolve: (message: JsonRpcMessage) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly binary: string, private readonly args: string[] = ["mcp"]) {}

  async start(): Promise<McpTool[]> {
    this.child = spawn(this.binary, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString()));
    this.child.on("exit", () => this.failAll("hand exited"));
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "machinectl", version: "0" } });
    this.notify("notifications/initialized");
    const listed = (await this.request("tools/list", {})).result as { tools?: McpTool[] } | undefined;
    return listed?.tools ?? [];
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const reply = await this.request("tools/call", { name, arguments: args });
    if (reply.error) throw new Error(reply.error.message ?? "hand call failed");
    const result = reply.result as McpContent;
    const text = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
    if (result.isError) throw new Error(text || "hand reported an error");
    return text;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  private notify(method: string): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  private request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ id, error: { message: `hand did not answer ${method} within ${HAND_CALL_TIMEOUT_MS}ms` } });
      }, HAND_CALL_TIMEOUT_MS);
      this.waiting.set(id, { resolve, timer });
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonRpcMessage;
      if (typeof message.id !== "number") continue;
      const waiter = this.waiting.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      this.waiting.delete(message.id);
      waiter.resolve(message);
    }
  }

  private failAll(reason: string): void {
    for (const [id, waiter] of this.waiting) {
      clearTimeout(waiter.timer);
      waiter.resolve({ id, error: { message: reason } });
    }
    this.waiting.clear();
  }
}

export function handToolsFor(client: HandClient, tools: McpTool[]): RegisteredTool[] {
  return tools.map((tool) => ({
    name: `${HAND_TOOL_PREFIX}${tool.name}`,
    description: (tool.description ?? `hand ${tool.name}`).slice(0, 2_000),
    inputSchemaJson: tool.inputSchema ?? { type: "object" },
    validator: z.record(z.unknown()),
    handler: (args) => client.call(tool.name, args as Record<string, unknown>),
  }));
}

export async function buildHandTools(): Promise<{ tools: RegisteredTool[]; client: HandClient | null; note: string }> {
  if (process.env.MACHINECTL_ENABLE_HAND !== "1") return { tools: [], client: null, note: "hand disabled (set MACHINECTL_ENABLE_HAND=1)" };
  const binary = handBinary();
  if (!binary) return { tools: [], client: null, note: "hand not found (install hand.app or set MACHINECTL_HAND_BIN)" };
  const client = new HandClient(binary);
  try {
    const tools = handToolsFor(client, await client.start());
    return { tools, client, note: `hand tools: ${tools.map((tool) => tool.name).join(", ")}` };
  } catch (error) {
    client.stop();
    return { tools: [], client: null, note: `hand failed to start: ${(error as Error).message}` };
  }
}
