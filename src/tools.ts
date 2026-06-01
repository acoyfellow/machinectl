import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile as fsReadFile, realpath as fsRealpath, unlink as fsUnlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { z, type ZodSchema } from "zod";
import { buildAgentSessionTools } from "./agent-sessions.js";
import type { RegisteredTool, ToolHandler } from "./protocol.js";

const SHELL_TIMEOUT_MS = boundedInt("MACHINECTL_SHELL_TIMEOUT", 60_000, 1_000, 24 * 60 * 60 * 1000);
const SHELL_OUTPUT_CAP = 256 * 1024;
const SHELL_STOP_GRACE_MS = 2_000;
const SCREENSHOT_MAX_BYTES = boundedInt("MACHINECTL_SCREENSHOT_MAX_BYTES", 8 * 1024 * 1024, 1024, 64 * 1024 * 1024);
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
  "Capture the current screen and return a PNG data URL. May reveal sensitive on-screen information.",
  { type: "object", properties: {} },
  z.object({}).strict(),
  async () => {
    const path = pathJoin(tmpdir(), `machinectl-${randomUUID()}.png`);
    try {
      if (platform() === "darwin") {
        const result = await run("/usr/sbin/screencapture", ["-x", path]);
        if (result.code !== 0) throw new Error(result.stderr || "screenshot command failed");
      } else if (platform() === "linux") {
        const result = await run("bash", ["-lc", `grim ${JSON.stringify(path)} 2>/dev/null || scrot ${JSON.stringify(path)}`]);
        if (result.code !== 0) throw new Error(result.stderr || "screenshot command failed");
      } else throw new Error(`screenshot is unsupported on ${platform()}`);
      const bytes = await fsReadFile(path);
      if (bytes.length > SCREENSHOT_MAX_BYTES) throw new Error(`screenshot exceeds ${SCREENSHOT_MAX_BYTES} byte limit`);
      return `data:image/png;base64,${bytes.toString("base64")}`;
    } finally { await fsUnlink(path).catch(() => undefined); }
  },
);

const mouseTool = tool(
  "mouse",
  "Move, click, double-click, or scroll the pointer on macOS. Requires user-approved Accessibility permission.",
  { type: "object", properties: { action: { type: "string", enum: ["move", "click", "double_click", "scroll"] }, x: { type: "number" }, y: { type: "number" }, delta: { type: "number" } }, required: ["action"] },
  z.object({ action: z.enum(["move", "click", "double_click", "scroll"]), x: z.number().int().optional(), y: z.number().int().optional(), delta: z.number().int().optional() }),
  async ({ action, x, y, delta }) => {
    if (platform() !== "darwin") throw new Error("mouse is currently implemented only on macOS");
    if (action !== "scroll" && (x === undefined || y === undefined)) throw new Error(`${action} requires x and y`);
    const script = action === "move" ? `tell application "System Events" to set the position of the mouse to {${x}, ${y}}`
      : action === "click" ? `tell application "System Events" to click at {${x}, ${y}}`
      : action === "double_click" ? `tell application "System Events" to double click at {${x}, ${y}}`
      : `tell application "System Events" to scroll ${delta ?? 0}`;
    const result = await run("/usr/bin/osascript", ["-e", script]);
    if (result.code !== 0) throw new Error(result.stderr || "mouse action failed");
    return `Mouse action completed: ${action}`;
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
    if (action === "type") { if (text === undefined) throw new Error("type requires text"); script = `tell application "System Events" to keystroke ${JSON.stringify(text)}`; }
    else {
      if (!key) throw new Error("key requires key");
      const codes: Record<string, number> = { return: 36, enter: 36, tab: 48, escape: 53, space: 49, delete: 51, up: 126, down: 125, left: 123, right: 124 };
      const using = modifiers.length ? ` using {${modifiers.map((modifier) => `${modifier} down`).join(", ")}}` : "";
      script = codes[key.toLowerCase()] !== undefined ? `tell application "System Events" to key code ${codes[key.toLowerCase()]}${using}` : `tell application "System Events" to keystroke ${JSON.stringify(key)}${using}`;
    }
    const result = await run("/usr/bin/osascript", ["-e", script]);
    if (result.code !== 0) throw new Error(result.stderr || "keyboard action failed");
    return `Keyboard action completed: ${action}`;
  },
);

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
  return [shellTool, screenshotTool, mouseTool, keyboardTool, ...buildAgentSessionTools()];
}
