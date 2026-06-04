import { Hono, type Context } from "hono";
import { accessMiddleware, type AccessIdentity } from "./auth";
import { handleCodeModeRequest } from "./codemode";
import { MachineHost, type PublishedTool } from "./machine-host";

interface Env {
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ISS?: string;
  MACHINECTL_ENV?: string;
  MACHINECTL_DEV_AUTH?: string;
  MACHINECTL_DEV_EMAIL?: string;
  MACHINECTL_ALLOWED_EMAILS?: string;
  MACHINECTL_ALLOW_DIRECT_TOOLS?: string;
  MACHINECTL_LOCATION_HINT?: string;
  MACHINE_HOST: DurableObjectNamespace<MachineHost>;
  AUDIT_KV?: KVNamespace;
  LOADER: WorkerLoader;
  ASSETS?: Fetcher;
}

type AppEnv = { Bindings: Env; Variables: { identity: AccessIdentity } };
type ToolResult = { ok: true; content: string } | { ok: false; error: string };

export { MachineHost } from "./machine-host";

const app = new Hono<AppEnv>();
// No public product routes: the control UI, health, MCP, and daemon socket all
// require the same Access identity. Local E2E opts into a development bypass.
app.use("*", accessMiddleware());
app.get("/health", (c) => c.json({ ok: true, name: "machinectl", codemode: true, operator: c.get("identity").email }));

function machineHost(c: Context<AppEnv>) {
  const identity = c.get("identity");
  const id = c.env.MACHINE_HOST.idFromName(identity.email);
  const locationHint = c.env.MACHINECTL_LOCATION_HINT as "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "oc" | "afr" | "me" | undefined;
  return c.env.MACHINE_HOST.get(id, locationHint ? { locationHint } : undefined);
}

function internalRequest(c: Context<AppEnv>, path: string, includeBody = false) {
  const identity = c.get("identity");
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Machinectl-Identity-Email", identity.email);
  headers.set("X-Machinectl-Identity-Sub", identity.sub);
  return new Request(`http://internal${path}`, { method: c.req.method, headers, ...(includeBody ? { body: c.req.raw.body } : {}) });
}

async function status(c: Context<AppEnv>) {
  return machineHost(c).fetch("http://internal/status");
}

async function forwardedCall(c: Context<AppEnv>, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const identity = c.get("identity");
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Machinectl-Identity-Email": identity.email,
    "X-Machinectl-Identity-Sub": identity.sub,
  });
  return machineHost(c).fetch(new Request("http://internal/call", { method: "POST", headers, body: JSON.stringify({ tool, arguments: args }) })).then((response) => response.json<ToolResult>());
}

app.get("/machinectl/connect", (c) => machineHost(c).fetch(internalRequest(c, "/connect")));
function directToolsEnabled(c: Context<AppEnv>) {
  return c.env.MACHINECTL_ENV === "development" || c.env.MACHINECTL_ALLOW_DIRECT_TOOLS === "1";
}
app.post("/mcp/direct", (c) => directToolsEnabled(c) ? machineHost(c).fetch(internalRequest(c, "/mcp", true)) : c.json({ error: "direct MCP tools are disabled" }, 404));
app.post("/machinectl/mcp", (c) => directToolsEnabled(c) ? machineHost(c).fetch(internalRequest(c, "/mcp", true)) : c.json({ error: "direct MCP tools are disabled" }, 404)); // compatibility endpoint
app.get("/api/status", status);
app.get("/machinectl/status", status);
app.post("/api/call", async (c) => {
  if (!directToolsEnabled(c)) return c.json({ ok: false, error: "direct proof controls are disabled" }, 404);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > 128 * 1024) return c.json({ ok: false, error: "request too large" }, 413);
  const body = await Promise.resolve().then(() => JSON.parse(text) as { tool?: string; arguments?: Record<string, unknown> }).catch(() => null);
  if (!body?.tool) return c.json({ ok: false, error: "tool is required" }, 400);
  return c.json(await forwardedCall(c, body.tool, body.arguments ?? {}));
});
app.post("/api/code", async (c) => {
  const requestText = await c.req.text();
  if (new TextEncoder().encode(requestText).byteLength > 128 * 1024) return c.json({ ok: false, error: "request too large" }, 413);
  const body = await Promise.resolve().then(() => JSON.parse(requestText) as { code?: string }).catch(() => null);
  if (!body?.code || body.code.length > 64 * 1024) return c.json({ ok: false, error: "code is required and must be at most 64 KB" }, 400);
  const state = await status(c).then((response) => response.json<{ connected: boolean; tools?: PublishedTool[] }>());
  const mcpRequest = new Request("http://internal/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "code", arguments: { code: body.code } } }),
  });
  const response = await handleCodeModeRequest(mcpRequest, c.env, state.connected ? state.tools ?? [] : [], (tool, args) => forwardedCall(c, tool, args));
  const json = await response.json<{ result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string } }>().catch(() => null);
  if (!json) return c.json({ ok: false, error: "invalid code response" }, 500);
  const text = json.result?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? json.error?.message ?? "";
  if (text.startsWith("data:image/")) return c.json({ ok: true, kind: "image", content: text });
  return c.json({ ok: !json.result?.isError && !json.error, content: text, error: json.result?.isError || json.error ? text : undefined });
});
app.post("/mcp", async (c) => {
  const state = await status(c).then((response) => response.json<{ connected: boolean; tools?: PublishedTool[] }>());
  return handleCodeModeRequest(c.req.raw, c.env, state.connected ? state.tools ?? [] : [], (tool, args) => forwardedCall(c, tool, args));
});

app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("machinectl app not built", 404);
});

export default app;
