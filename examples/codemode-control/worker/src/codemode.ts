import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { PublishedTool } from "./machine-host";
import { AttachmentStore, isImageDataUrl } from "./attachments";
import { CallGovernor, catalogHash } from "./call-governor";
import { checkArgs } from "./arg-guard";

export interface CodeModeEnv {
  LOADER: WorkerLoader;
}

type ToolResult = { ok: true; content: string } | { ok: false; error: string };
type Forward = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface CodeModeExecutionRecord {
  executionId: string;
  toolsHash: string;
  calls: number;
  rejected: number;
  ok: boolean;
  elapsedMs: number;
  toolsInvoked: readonly string[];
  attachments: readonly { attachmentId: string; mediaType: string; byteLength: number }[];
  attachmentsReturned: readonly string[];
}

export type RecordExecution = (record: CodeModeExecutionRecord) => void;

const CODE_TIMEOUT_MS = 30_000;
const CODE_RESULT_MAX_CHARS = 24_000;
const IMAGE_RESULT_MAX_BYTES = 12 * 1024 * 1024;

function parseLaptopResult(content: string): unknown {
  try { return JSON.parse(content) as unknown; } catch { return content; }
}

function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

function tsType(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const value = schema as Record<string, unknown>;
  if (Array.isArray(value.enum)) return value.enum.map((entry) => JSON.stringify(entry)).join(" | ");
  if (value.type === "string") return "string";
  if (value.type === "number" || value.type === "integer") return "number";
  if (value.type === "boolean") return "boolean";
  if (value.type === "array") return `Array<${tsType(value.items)}>`;
  if (value.type === "object") {
    const properties = (value.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(value.required) ? value.required.map(String) : []);
    return `{ ${Object.entries(properties).map(([key, field]) => `${key}${required.has(key) ? "" : "?"}: ${tsType(field)}`).join("; ")} }`;
  }
  return "unknown";
}

function typesForCatalog(catalog: PublishedTool[]): string {
  const declarations = catalog.map((tool) => {
    const method = safeToolName(tool.name).replace(/[-.]/g, "_");
    return `  /** ${tool.description.replaceAll("*/", "* /")} */\n  ${method}: (args: ${tsType(tool.inputSchema)}) => Promise<unknown>;`;
  });
  return `declare const codemode: {\n${declarations.join("\n\n")}\n};`;
}

function addLaptopTools(server: McpServer, catalog: PublishedTool[], forward: Forward) {
  for (const published of catalog) {
    const name = safeToolName(published.name);
    server.registerTool(name, {
      description: published.description,
      inputSchema: z.record(z.string(), z.unknown()),
    }, async (args) => {
      const result = await forward(published.name, args ?? {});
      if (!result.ok) return { isError: true, content: [{ type: "text" as const, text: result.error }] };
      return { content: [{ type: "text" as const, text: result.content }] };
    });
  }
}

export async function handleCodeModeRequest(request: Request, env: CodeModeEnv, catalog: PublishedTool[], forward: Forward, recordExecution?: RecordExecution): Promise<Response> {
  const upstream = new McpServer({ name: "machinectl-direct", version: "0.1.0" });
  addLaptopTools(upstream, catalog, forward);

  // This is the codeMcpServer pattern implemented explicitly so dynamic tools
  // retain the daemon's late-bound catalog while generated code runs isolated.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { sanitizeToolName } = await import("@cloudflare/codemode");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await upstream.connect(serverTransport);
  const client = new Client({ name: "machinectl-code-proxy", version: "0.1.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const attachments = new AttachmentStore();
  const governor = new CallGovernor();
  const fns: Record<string, (args: unknown) => Promise<unknown>> = {};
  const schemaByName = new Map(catalog.map((entry) => [entry.name, entry.inputSchema]));
  const toolsInvoked: string[] = [];
  for (const tool of tools) {
    fns[tool.name] = async (args) => governor.run(tool.name, async () => {
      if (!toolsInvoked.includes(tool.name)) toolsInvoked.push(tool.name);
      const rejection = checkArgs(tool.name, schemaByName.get(tool.name), args);
      if (rejection) throw new Error(rejection.error);
      const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      const texts = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      if (result.isError) throw new Error(texts || "Laptop tool failed");
      if (isImageDataUrl(texts)) {
        const retained = attachments.retain(texts);
        if ("error" in retained) throw new Error(retained.error);
        return retained;
      }
      return parseLaptopResult(texts);
    });
  }
  const toolsHash = await catalogHash(tools.map((tool) => tool.name));
  const types = typesForCatalog(catalog);
  const exampleTool = catalog.find((tool) => tool.name === "screenshot") ?? catalog[0];
  const example = exampleTool
    ? `Example: async () => { const r = await codemode.${sanitizeToolName(exampleTool.name)}(${exampleTool.name === "screenshot" ? "{ format: \"jpeg\", maxWidth: 1280, quality: 65 }" : "{}"}); return r; }`
    : "The laptop is offline; no capability methods are currently available.";
  const executor = new DynamicWorkerExecutor({ loader: env.LOADER, globalOutbound: null, timeout: CODE_TIMEOUT_MS });
  const coded = new McpServer({ name: "machinectl-codemode", version: "0.1.0" });
  coded.registerTool("code", {
    description: `Execute JavaScript against an explicitly connected laptop through isolated Code Mode. The underlying shell capability is terminal-equivalent; use it only when authorized. External network access from this orchestration sandbox is disabled.\n\nAvailable methods:\n${types}\n\nWrite an async arrow function in JavaScript that returns the result. Do not use TypeScript syntax.\n\n${example}`,
    inputSchema: { code: z.string().describe("JavaScript async arrow function to execute") },
  }, async ({ code }) => {
    const executionId = crypto.randomUUID();
    const startedAt = Date.now();
    const execution = await executor.execute(code, [{ name: "codemode", fns }]);
    const referencedOnError = execution.error ? [] : attachments.referenced(execution.result);
    const record: CodeModeExecutionRecord = {
      executionId,
      toolsHash,
      ...governor.metrics,
      ok: !execution.error,
      elapsedMs: Date.now() - startedAt,
      toolsInvoked: [...toolsInvoked],
      attachments: attachments.manifest(),
      attachmentsReturned: referencedOnError.map((entry) => entry.id),
    };
    console.log("machinectl_codemode_execution", record);
    recordExecution?.(record);
    if (execution.error) return { isError: true, content: [{ type: "text" as const, text: execution.error }] };
    const referenced = referencedOnError;
    const text = typeof execution.result === "string" ? execution.result : JSON.stringify(execution.result, null, 2);
    const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text" as const, text: text.slice(0, CODE_RESULT_MAX_CHARS) },
    ];
    let imageBytes = 0;
    for (const attachment of referenced) {
      if (imageBytes + attachment.byteLength > IMAGE_RESULT_MAX_BYTES) break;
      imageBytes += attachment.byteLength;
      parts.push({ type: "image" as const, data: attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1), mimeType: attachment.mediaType });
    }
    return { content: parts };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await coded.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    transport.close().catch(() => undefined);
    coded.close().catch(() => undefined);
    upstream.close().catch(() => undefined);
  }
}
