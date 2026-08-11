export interface PublishedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export type ToolResult = { ok: true; content: string } | { ok: false; error: string };

const TOOL_LIMIT = 64;
const CATALOG_BYTE_LIMIT = 128 * 1024;
const RESULT_BYTE_LIMIT = 512 * 1024;
const SCREENSHOT_RESULT_BYTE_LIMIT = 12 * 1024 * 1024;
const SAFE_RASTER_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i;
const GENERIC_MEDIA_DATA_URL_RE = /^data:(?:image|video|audio)\//i;
const RASTER_RESULT_BYTE_LIMIT = 64 * 1024 * 1024;

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

export function safeText(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  return value.slice(0, maxBytes) + "\n... (truncated by relay)";
}

export function sanitizeSuccessResult(tool: string, content: string): ToolResult {
  if (tool === "screenshot") {
    if (!SAFE_RASTER_DATA_URL_RE.test(content)) return { ok: false, error: "invalid screenshot response" };
    if (byteLength(content) > SCREENSHOT_RESULT_BYTE_LIMIT) return { ok: false, error: "screenshot response exceeds relay limit" };
    return { ok: true, content };
  }
  if (SAFE_RASTER_DATA_URL_RE.test(content)) {
    if (byteLength(content) > RASTER_RESULT_BYTE_LIMIT) {
      return { ok: false, error: `${tool} raster response exceeds the ${RASTER_RESULT_BYTE_LIMIT} byte relay limit and was not truncated, because truncated raster data does not decode` };
    }
    return { ok: true, content };
  }
  if (GENERIC_MEDIA_DATA_URL_RE.test(content)) {
    return { ok: false, error: `${tool} returned an unsupported or malformed media data URL` };
  }
  return { ok: true, content: safeText(content, RESULT_BYTE_LIMIT) };
}

export function validateTools(tools: unknown): tools is PublishedTool[] {
  if (!Array.isArray(tools) || tools.length > TOOL_LIMIT || byteLength(tools) > CATALOG_BYTE_LIMIT) return false;
  return tools.every((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const value = tool as Record<string, unknown>;
    const schema = value.inputSchema;
    return typeof value.name === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value.name) && typeof value.description === "string" && value.description.length <= 2_000 && !!schema && typeof schema === "object" && !Array.isArray(schema) && Object.keys(schema).length > 0;
  });
}

export function summarizeArgs(tool: string, args: Record<string, unknown>) {
  const allowedKeys = tool === "shell"
    ? ["cwd", "timeoutMs"]
    : tool === "mouse"
      ? ["action", "x", "y", "delta"]
      : tool === "keyboard"
        ? ["action", "key", "modifiers"]
        : tool === "screenshot"
          ? ["format", "quality", "maxWidth", "fullResolution", "display", "region"]
          : tool === "input_sequence"
            ? []
            : tool === "accessibility_query"
              ? ["op", "app", "window", "role", "depth", "maxNodes", "limit"]
              : tool === "accessibility_action"
                ? ["op", "elementId"]
        : tool === "harness_start" || tool === "pi_start"
        ? ["harnessId", "cwd", "model", "thinking", "continueRecent"]
        : ["harness_status", "harness_logs", "harness_stop", "harness_abort", "harness_control", "pi_status", "pi_logs", "pi_stop", "pi_abort", "pi_command"].includes(tool)
          ? ["harnessId", "id", "command", "eventLimit", "tailChars"]
          : [];
  const summary: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in args && !["key", "modifiers", "command"].includes(key)) summary[key] = args[key];
  }
  return { keyCount: Object.keys(args).length, byteLength: byteLength(args), safe: summary, contentRedacted: true };
}
