import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile as fsReadFile, realpath as fsRealpath, unlink as fsUnlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { z, type ZodSchema } from "zod";
import { buildAgentSessionTools } from "./agent-sessions.js";
import { accessibilityAction, accessibilityQuery } from "./accessibility.js";
import type { RegisteredTool, ToolHandler } from "./protocol.js";

const SHELL_TIMEOUT_MS = boundedInt("MACHINECTL_SHELL_TIMEOUT", 60_000, 1_000, 24 * 60 * 60 * 1000);
const SHELL_OUTPUT_CAP = 256 * 1024;
const SHELL_STOP_GRACE_MS = 2_000;
const SCREENSHOT_MAX_BYTES = boundedInt("MACHINECTL_SCREENSHOT_MAX_BYTES", 8 * 1024 * 1024, 1024, 64 * 1024 * 1024);
const SCREENSHOT_DEFAULT_MAX_WIDTH = boundedInt("MACHINECTL_SCREENSHOT_DEFAULT_MAX_WIDTH", 1440, 320, 10_000);
const SCREENSHOT_DEFAULT_QUALITY = boundedInt("MACHINECTL_SCREENSHOT_DEFAULT_QUALITY", 68, 1, 100);
const LOCAL_AUTH_STATUS_MAX_BYTES = 16 * 1024;
const LOCAL_AUTH_STATUS_CACHE_MS = 60_000;
const activeShells = new Set<ReturnType<typeof spawn>>();
const allowedCwds = (process.env.MACHINECTL_ALLOWED_PATHS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((root) => pathResolve(root));

function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

async function validateCwd(cwd: string): Promise<string> {
  if (allowedCwds.length === 0) throw new Error("Set MACHINECTL_ALLOWED_PATHS before passing shell.cwd.");
  const canonical = await fsRealpath(pathResolve(cwd)).catch(() => { throw new Error(`cwd does not exist: ${cwd}`); });
  const roots = await Promise.all(allowedCwds.map((root) => fsRealpath(root).catch(() => root)));
  if (!roots.some((root) => canonical === root || canonical.startsWith(root + "/"))) {
    throw new Error(`cwd is outside MACHINECTL_ALLOWED_PATHS: ${cwd}`);
  }
  return canonical;
}

function tool<S extends ZodSchema>(name: string, description: string, inputSchemaJson: Record<string, unknown>, validator: S, handler: ToolHandler<z.infer<S>>): RegisteredTool<S> {
  return { name, description, inputSchemaJson, validator, handler: handler as ToolHandler };
}

function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") { try { child.kill(signal); } catch {} return; }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

export function shutdownTools(): void {
  for (const child of activeShells) {
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), SHELL_STOP_GRACE_MS).unref();
  }
}

const shellTool = tool(
  "shell",
  "Run a shell command as the local user. This is terminal-equivalent capability. Optional cwd must be inside MACHINECTL_ALLOWED_PATHS.",
  { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] },
  z.object({ command: z.string().min(1), cwd: z.string().min(1).optional(), timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).optional() }),
  async ({ command, cwd, timeoutMs }) => new Promise<string>(async (resolve, reject) => {
    let safeCwd: string | undefined;
    try { safeCwd = cwd ? await validateCwd(cwd) : undefined; } catch (error) { reject(error); return; }
    const child = spawn("bash", ["-lc", command], { cwd: safeCwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    activeShells.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { if (stdout.length < SHELL_OUTPUT_CAP) stdout = (stdout + data.toString()).slice(0, SHELL_OUTPUT_CAP); });
    child.stderr.on("data", (data) => { if (stderr.length < SHELL_OUTPUT_CAP) stderr = (stderr + data.toString()).slice(0, SHELL_OUTPUT_CAP); });
    const duration = timeoutMs ?? SHELL_TIMEOUT_MS;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), SHELL_STOP_GRACE_MS).unref();
      reject(new Error(`shell timed out after ${duration}ms`));
    }, duration);
    child.on("error", (error) => { activeShells.delete(child); clearTimeout(timeout); if (!settled) { settled = true; reject(error); } });
    child.on("close", (code) => {
      activeShells.delete(child); clearTimeout(timeout); if (settled) return; settled = true;
      resolve(`Exit code: ${code ?? "?"}\n${stdout}${stderr.trim() ? `\n--- stderr ---\n${stderr}` : ""}`.trim());
    });
  }),
);

const screenshotTool = tool(
  "screenshot",
  "Capture the current screen and return an image data URL. Defaults to a bandwidth-efficient JPEG preview; request format=png and fullResolution=true only when exact pixels are needed. May reveal sensitive on-screen information.",
  { type: "object", properties: { format: { type: "string", enum: ["jpeg", "png"] }, quality: { type: "number" }, maxWidth: { type: "number" }, fullResolution: { type: "boolean" }, display: { type: "number" }, region: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["x", "y", "width", "height"] } } },
  z.object({ format: z.enum(["jpeg", "png"]).optional().default("jpeg"), quality: z.number().int().min(1).max(100).optional(), maxWidth: z.number().int().min(320).max(10_000).optional(), fullResolution: z.boolean().optional().default(false), display: z.number().int().min(1).max(32).optional(), region: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) }).optional() }).strict(),
  async (args) => {
    const { format = "jpeg", quality, maxWidth, fullResolution = false, display, region } = args;
    const startedAt = Date.now();
    const ext = format === "jpeg" ? "jpg" : "png";
    const capturedPath = pathJoin(tmpdir(), `machinectl-${randomUUID()}.png`);
    const outputPath = pathJoin(tmpdir(), `machinectl-${randomUUID()}.${ext}`);
    try {
      if (platform() === "darwin") {
        const captureArgs = ["-x", "-t", "png"];
        if (display !== undefined) captureArgs.push(`-D${display}`);
        if (region) captureArgs.push(`-R${region.x},${region.y},${region.width},${region.height}`);
        captureArgs.push(capturedPath);
        const result = await run("/usr/sbin/screencapture", captureArgs);
        if (result.code !== 0) throw new Error(result.stderr || "screenshot command failed");
        const targetWidth = fullResolution ? undefined : maxWidth ?? SCREENSHOT_DEFAULT_MAX_WIDTH;
        if (format !== "png" || targetWidth !== undefined) {
          const conversionArgs = ["-s", "format", format, ...(format === "jpeg" ? ["-s", "formatOptions", String(quality ?? SCREENSHOT_DEFAULT_QUALITY)] : []), ...(targetWidth ? ["--resampleWidth", String(targetWidth)] : []), capturedPath, "--out", outputPath];
          const converted = await run("/usr/bin/sips", conversionArgs);
          if (converted.code !== 0) throw new Error(converted.stderr || "screenshot conversion failed");
        }
      } else if (platform() === "linux") {
        if (format !== "png" || (!fullResolution && (maxWidth ?? SCREENSHOT_DEFAULT_MAX_WIDTH))) throw new Error("compressed screenshot previews are currently implemented only on macOS; request format=png and fullResolution=true");
        const result = await run("bash", ["-lc", `grim ${JSON.stringify(capturedPath)} 2>/dev/null || scrot ${JSON.stringify(capturedPath)}`]);
        if (result.code !== 0) throw new Error(result.stderr || "screenshot command failed");
      } else throw new Error(`screenshot is unsupported on ${platform()}`);
      const finalPath = format === "png" && (fullResolution || platform() !== "darwin") ? capturedPath : outputPath;
      const bytes = await fsReadFile(finalPath);
      if (bytes.length > SCREENSHOT_MAX_BYTES) throw new Error(`screenshot exceeds ${SCREENSHOT_MAX_BYTES} byte limit`);
      const mime = format === "jpeg" ? "image/jpeg" : "image/png";
      const metadata = { format, bytes: bytes.length, durationMs: Date.now() - startedAt, widthLimited: !fullResolution && (maxWidth ?? SCREENSHOT_DEFAULT_MAX_WIDTH) };
      if (process.env.MACHINECTL_LOG_TIMING === "1") console.log("[machinectl]", "timing", "screenshot", JSON.stringify(metadata));
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } finally {
      await Promise.all([fsUnlink(capturedPath).catch(() => undefined), fsUnlink(outputPath).catch(() => undefined)]);
    }
  },
);

type InputAction =
  | { action: "move"; x: number; y: number }
  | { action: "click"; x: number; y: number }
  | { action: "double_click"; x: number; y: number }
  | { action: "scroll"; delta: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string; modifiers?: Array<"command" | "control" | "option" | "shift"> };

function appleScriptForKeyboard(action: Extract<InputAction, { action: "type" | "key" }>): string {
  if (action.action === "type") return `tell application "System Events" to keystroke ${JSON.stringify(action.text)}`;
  const codes: Record<string, number> = { return: 36, enter: 36, tab: 48, escape: 53, space: 49, delete: 51, up: 126, down: 125, left: 123, right: 124 };
  const modifiers = action.modifiers ?? [];
  const using = modifiers.length ? ` using {${modifiers.map((modifier) => `${modifier} down`).join(", ")}}` : "";
  return codes[action.key.toLowerCase()] !== undefined ? `tell application "System Events" to key code ${codes[action.key.toLowerCase()]}${using}` : `tell application "System Events" to keystroke ${JSON.stringify(action.key)}${using}`;
}

function swiftForPointerAction(action: Extract<InputAction, { action: "move" | "click" | "double_click" | "scroll" }>): string {
  if (action.action === "move") return `CGWarpMouseCursorPosition(CGPoint(x: ${action.x}, y: ${action.y}))`;
  if (action.action === "scroll") return `CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(${action.delta}), wheel2: 0, wheel3: 0)!.post(tap: .cghidEventTap)`;
  const click = `let p = CGPoint(x: ${action.x}, y: ${action.y}); CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap); CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)`;
  return action.action === "double_click" ? `${click}; ${click}` : click;
}

async function runInputActions(actions: InputAction[]): Promise<void> {
  const keyboardActions = actions.filter((action): action is Extract<InputAction, { action: "type" | "key" }> => action.action === "type" || action.action === "key");
  const pointerActions = actions.filter((action): action is Extract<InputAction, { action: "move" | "click" | "double_click" | "scroll" }> => action.action !== "type" && action.action !== "key");
  // Preserve order when a batch mixes pointer and keyboard actions. Pure pointer
  // batches use one compiled Swift invocation; pure keyboard batches use one osascript invocation.
  if (pointerActions.length === actions.length) {
    const result = await run("/usr/bin/swift", ["-e", `import CoreGraphics; ${pointerActions.map(swiftForPointerAction).join("; ")}`]);
    if (result.code !== 0) throw new Error(result.stderr || "pointer action failed");
    return;
  }
  if (keyboardActions.length === actions.length) {
    const result = await run("/usr/bin/osascript", keyboardActions.flatMap((action) => ["-e", appleScriptForKeyboard(action)]));
    if (result.code !== 0) throw new Error(result.stderr || "keyboard action failed");
    return;
  }
  for (const action of actions) await runInputActions([action]);
}

const mouseTool = tool(
  "mouse",
  "Move, click, double-click, or scroll the pointer on macOS. Requires user-approved Accessibility permission.",
  { type: "object", properties: { action: { type: "string", enum: ["move", "click", "double_click", "scroll"] }, x: { type: "number" }, y: { type: "number" }, delta: { type: "number" } }, required: ["action"] },
  z.object({ action: z.enum(["move", "click", "double_click", "scroll"]), x: z.number().int().optional(), y: z.number().int().optional(), delta: z.number().int().optional() }),
  async ({ action, x, y, delta }) => {
    if (platform() !== "darwin") throw new Error("mouse is currently implemented only on macOS");
    if (action !== "scroll" && (x === undefined || y === undefined)) throw new Error(`${action} requires x and y`);
    await runInputActions([action === "scroll" ? { action, delta: delta ?? 0 } : { action, x: x!, y: y! }]);
    return `Mouse action completed: ${action}`;
  },
);

let localAuthStatusCache: { at: number; content: string } | undefined;

export function projectLocalAuthStatus(value: unknown): string {
  const report = value as { version?: unknown; checkedAt?: unknown; resources?: unknown[] };
  const resources = Array.isArray(report?.resources) ? report.resources.slice(0, 32) : [];
  const safe = {
    version: String(report?.version ?? "").slice(0, 32),
    checkedAt: String(report?.checkedAt ?? "").slice(0, 40),
    resources: resources.map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        id: String(item.id ?? "").slice(0, 64),
        label: String(item.label ?? "").slice(0, 100),
        kind: String(item.kind ?? "").slice(0, 64),
        state: String(item.state ?? "").slice(0, 32),
        ...(item.accessTokenState ? { accessTokenState: String(item.accessTokenState).slice(0, 32) } : {}),
        ...(item.expiresAt ? { expiresAt: String(item.expiresAt).slice(0, 40) } : {}),
      };
    }),
  };
  const content = JSON.stringify(safe, null, 2);
  if (Buffer.byteLength(content) > LOCAL_AUTH_STATUS_MAX_BYTES) throw new Error("cf-local status exceeded safe output limit");
  return content;
}

const localAuthStatusTool = tool(
  "local_auth_status",
  "Return a bounded, secret-free cf-local health summary for laptop Cloudflare resources. Diagnostic only: never auto-execute recovery commands or ask the user to relink without explicit confirmation.",
  { type: "object", properties: {} },
  z.object({}).strict(),
  async () => {
    if (localAuthStatusCache && Date.now() - localAuthStatusCache.at < LOCAL_AUTH_STATUS_CACHE_MS) return localAuthStatusCache.content;
    const bin = process.env.CF_LOCAL_BIN ?? pathJoin(process.env.HOME ?? "", ".local", "bin", "cf-local");
    // Keep this as direct argv spawning. Do not change to bash -lc: CF_LOCAL_BIN
    // must never become shell-interpreted input.
    const result = await runBounded(bin, ["status", "--json", "--remote"], 10_000, LOCAL_AUTH_STATUS_MAX_BYTES);
    if (result.code !== 0) throw new Error((result.stderr || "cf-local status failed").slice(0, 300));
    const content = projectLocalAuthStatus(JSON.parse(result.stdout));
    localAuthStatusCache = { at: Date.now(), content };
    return content;
  },
);

const keyboardTool = tool(
  "keyboard",
  "Type text or send keys/shortcuts on macOS. Requires user-approved Accessibility permission.",
  { type: "object", properties: { action: { type: "string", enum: ["type", "key"] }, text: { type: "string" }, key: { type: "string" }, modifiers: { type: "array", items: { type: "string", enum: ["command", "control", "option", "shift"] } } }, required: ["action"] },
  z.object({ action: z.enum(["type", "key"]), text: z.string().optional(), key: z.string().optional(), modifiers: z.array(z.enum(["command", "control", "option", "shift"])).optional().default([]) }),
  async ({ action, text, key, modifiers }) => {
    if (platform() !== "darwin") throw new Error("keyboard is currently implemented only on macOS");
    let script: string;
    if (action === "type") { if (text === undefined) throw new Error("type requires text"); script = appleScriptForKeyboard({ action, text }); }
    else { if (!key) throw new Error("key requires key"); script = appleScriptForKeyboard({ action, key, modifiers }); }
    const result = await run("/usr/bin/osascript", ["-e", script]);
    if (result.code !== 0) throw new Error(result.stderr || "keyboard action failed");
    return `Keyboard action completed: ${action}`;
  },
);

const inputActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["move", "click", "double_click"]), x: z.number().int(), y: z.number().int() }),
  z.object({ action: z.literal("scroll"), delta: z.number().int() }),
  z.object({ action: z.literal("type"), text: z.string() }),
  z.object({ action: z.literal("key"), key: z.string().min(1), modifiers: z.array(z.enum(["command", "control", "option", "shift"])).optional().default([]) }),
]);

const accessibilityQueryTool = tool(
  "accessibility_query",
  "Query a bounded macOS accessibility tree. Use snapshot/find/focused/apps/windows to obtain temporary semantic element IDs; do not rely on screenshots when a semantic control is available.",
  { type: "object", properties: { op: { type: "string", enum: ["snapshot", "find", "focused", "apps", "windows"] }, app: { type: "string" }, window: { type: "string" }, text: { type: "string" }, role: { type: "string" }, depth: { type: "number" }, maxNodes: { type: "number" }, limit: { type: "number" } }, required: ["op"] },
  z.object({ op: z.enum(["snapshot", "find", "focused", "apps", "windows"]), app: z.string().max(200).optional(), window: z.string().max(200).optional(), text: z.string().max(200).optional(), role: z.string().max(100).optional(), depth: z.number().int().min(0).max(8).optional(), maxNodes: z.number().int().min(1).max(100).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  async (args) => accessibilityQuery(args),
);

const accessibilityActionTool = tool(
  "accessibility_action",
  "Act on a temporary macOS accessibility element ID returned by accessibility_query. IDs expire quickly and must be rediscovered after app/window changes.",
  { type: "object", properties: { op: { type: "string", enum: ["activate", "focus", "press", "setValue"] }, elementId: { type: "string" }, value: { type: "string" } }, required: ["op", "elementId"] },
  z.object({ op: z.enum(["activate", "focus", "press", "setValue"]), elementId: z.string().uuid(), value: z.string().max(10_000).optional() }).strict(),
  async (args) => accessibilityAction(args),
);

const inputSequenceTool = tool(
  "input_sequence",
  "Execute up to 32 mouse/keyboard actions in one local macOS input batch. Text content is sensitive and must not be persisted in audit receipts.",
  { type: "object", properties: { actions: { type: "array", maxItems: 32, items: { type: "object" } } }, required: ["actions"] },
  z.object({ actions: z.array(inputActionSchema).min(1).max(32) }).strict(),
  async ({ actions }) => {
    if (platform() !== "darwin") throw new Error("input_sequence is currently implemented only on macOS");
    await runInputActions(actions as InputAction[]);
    return `Input sequence completed: ${actions.length} action(s)`;
  },
);

function runBounded(command: string, args: string[], timeoutMs: number, maxBytes: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const append = (current: string, chunk: unknown) => (current + String(chunk)).slice(0, maxBytes);
    child.stdout.on("data", (data) => { stdout = append(stdout, data); });
    child.stderr.on("data", (data) => { stderr = append(stderr, data); });
    const timeout = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new Error(`${command} timed out after ${timeoutMs}ms`)); } }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timeout); if (!settled) { settled = true; reject(error); } });
    child.on("close", (code) => { clearTimeout(timeout); if (!settled) { settled = true; resolve({ code, stdout, stderr }); } });
  });
}

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function buildToolRegistry(): RegisteredTool[] {
  return [shellTool, screenshotTool, mouseTool, keyboardTool, inputSequenceTool, accessibilityQueryTool, accessibilityActionTool, localAuthStatusTool, ...buildAgentSessionTools()];
}
