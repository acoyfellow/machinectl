import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { PublishedTool } from "./machine-host";

export interface CodeModeEnv {
  LOADER: WorkerLoader;
}

type ToolResult = { ok: true; content: string } | { ok: false; error: string };
type Forward = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

const CODE_TIMEOUT_MS = 30_000;
const CODE_RESULT_MAX_CHARS = 24_000;
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/;
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

export async function handleCodeModeRequest(request: Request, env: CodeModeEnv, catalog: PublishedTool[], forward: Forward): Promise<Response> {
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
  const fns: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const tool of tools) {
    fns[tool.name] = async (args) => {
      const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      const texts = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      if (result.isError) throw new Error(texts || "Laptop tool failed");
      return parseLaptopResult(texts);
    };
  }
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
    const execution = await executor.execute(code, [{ name: "codemode", fns }]);
    if (execution.error) return { isError: true, content: [{ type: "text" as const, text: execution.error }] };
    const text = typeof execution.result === "string" ? execution.result : JSON.stringify(execution.result, null, 2);
    // Keep validated screenshot data URLs intact for this human-facing example
    // so its UI can render them. All other Code Mode output stays tightly bounded.
    if (text.startsWith("data:image/")) {
      if (!IMAGE_DATA_URL_RE.test(text) || new TextEncoder().encode(text).byteLength > IMAGE_RESULT_MAX_BYTES) {
        return { isError: true, content: [{ type: "text" as const, text: "invalid or oversized screenshot result" }] };
      }
      return { content: [{ type: "text" as const, text }] };
    }
    return { content: [{ type: "text" as const, text: text.slice(0, CODE_RESULT_MAX_CHARS) }] };
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
