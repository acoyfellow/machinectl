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
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/;

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

export function safeText(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  return value.slice(0, maxBytes) + "\n... (truncated by relay)";
}

export function sanitizeSuccessResult(tool: string, content: string): ToolResult {
  if (tool === "screenshot") {
    if (!IMAGE_DATA_URL_RE.test(content)) return { ok: false, error: "invalid screenshot response" };
    if (byteLength(content) > SCREENSHOT_RESULT_BYTE_LIMIT) return { ok: false, error: "screenshot response exceeds relay limit" };
    return { ok: true, content };
  }
  return { ok: true, content: safeText(content, RESULT_BYTE_LIMIT) };
}

export function validateTools(tools: unknown): tools is PublishedTool[] {
  if (!Array.isArray(tools) || tools.length > TOOL_LIMIT || byteLength(tools) > CATALOG_BYTE_LIMIT) return false;
  return tools.every((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const value = tool as Record<string, unknown>;
    return typeof value.name === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value.name) && typeof value.description === "string" && value.description.length <= 2_000 && !!value.inputSchema && typeof value.inputSchema === "object";
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
        : tool === "harness_start" || tool === "pi_start"
        ? ["harnessId", "cwd", "model", "thinking", "continueRecent"]
        : ["harness_status", "harness_logs", "harness_stop", "harness_abort", "harness_control", "pi_status", "pi_logs", "pi_stop", "pi_abort", "pi_command"].includes(tool)
          ? ["harnessId", "id", "command", "eventLimit", "tailChars"]
          : [];
  const summary: Record<string, unknown> = {};
  for (const key of allowedKeys) if (key in args) summary[key] = args[key];
  return { keys: Object.keys(args), byteLength: byteLength(args), safe: summary, contentRedacted: Object.keys(args).some((key) => !allowedKeys.includes(key)) };
}
