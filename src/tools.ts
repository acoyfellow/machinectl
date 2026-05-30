// tools.ts — every tool the laptop daemon exposes.
//
// Each tool exports a RegisteredTool: { name, description,
// inputSchemaJson (for the Worker → MCP catalog), validator (Zod, for
// daemon-side arg parsing), handler (the actual implementation).
//
// Path-restricted tools (read_file, write_file, list_directory, exec_command
// when cwd is set) reject anything that resolves outside
// MACHINECTL_ALLOWED_PATHS — which is REQUIRED to be set (no default).
// The daemon refuses to even register these tools if the env var is
// missing, so the tool catalog the Worker advertises is the intersection
// of "compiled in" and "user explicitly enabled."
//
// Allow-listing is path-prefix based, after fs.realpath() resolution
// (so symlinks can't smuggle escapes). Tests for this live in tests/.

import { execSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile, readdir as fsReaddir, mkdir as fsMkdir, realpath as fsRealpath } from "node:fs/promises";
import { dirname, resolve as pathResolve, join as pathJoin } from "node:path";
import { platform, tmpdir } from "node:os";
import { z, type ZodSchema } from "zod";
import type { RegisteredTool, ToolHandler } from "./protocol.js";
import { buildAgentSessionTools } from "./agent-sessions.js";

// ─── allow-listed paths ──────────────────────────────────────────────────

/** Parsed comma-separated list of allowed-path prefixes from
 *  MACHINECTL_ALLOWED_PATHS. Each entry is canonicalized at startup so
 *  symlinks don't trip the prefix check. Empty list = path tools refuse. */
const ALLOWED_PATHS: string[] = (process.env.MACHINECTL_ALLOWED_PATHS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => {
    try {
      return realpathSync(p);
    } catch {
      // Path doesn't exist yet — keep the literal absolute form. Per-call
      // validation below uses realpath on the closest existing ancestor
      // so created files inside an allowed dir still pass.
      return pathResolve(p);
    }
  });

/** True if filesystem-touching tools should be registered. */
export const FS_TOOLS_AVAILABLE = ALLOWED_PATHS.length > 0;

/** Throw if `path` doesn't resolve inside one of ALLOWED_PATHS. Uses
 *  realpath to defeat symlink escapes. For paths that don't exist yet,
 *  realpath the closest existing ancestor (handles "write a new file
 *  in an allowed directory"). */
async function assertAllowed(path: string): Promise<string> {
  if (ALLOWED_PATHS.length === 0) {
    throw new Error(
      "MACHINECTL_ALLOWED_PATHS is empty; filesystem tools refuse to operate. " +
        "Restart the daemon with MACHINECTL_ALLOWED_PATHS=/abs/path1,/abs/path2 .",
    );
  }
  const abs = pathResolve(path);
  // Walk up until we find a real ancestor we can realpath. That lets us
  // safely accept "create a file in an allowed dir" before the file
  // exists.
  let probe = abs;
  let canonical: string | null = null;
  while (true) {
    try {
      canonical = await fsRealpath(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (!canonical) {
    throw new Error(`Cannot resolve any ancestor of "${path}"`);
  }
  // For the actual file, splice the unresolved tail back onto the
  // canonical prefix. realpath the prefix; verify the result is inside.
  const suffix = abs.slice(probe.length);
  const candidate = canonical + suffix;
  const ok = ALLOWED_PATHS.some((root) => candidate === root || candidate.startsWith(root + "/"));
  if (!ok) {
    throw new Error(
      `Path "${path}" is outside MACHINECTL_ALLOWED_PATHS (${ALLOWED_PATHS.join(", ")}).`,
    );
  }
  return candidate;
}

// ─── helper: build a RegisteredTool with parallel zod + json-schema ──────
//
// Zod doesn't ship a "convert to JSON Schema" helper in the core
// package; rather than pull in zod-to-json-schema for one purpose, we
// hand-write both shapes. They live next to each other so divergence is
// loud.

function tool<S extends ZodSchema>(
  name: string,
  description: string,
  inputSchemaJson: Record<string, unknown>,
  validator: S,
  handler: ToolHandler<z.infer<S>>,
): RegisteredTool<S> {
  return {
    name,
    description,
    inputSchemaJson,
    validator,
    handler: handler as ToolHandler,
  };
}

// ─── exec_command ────────────────────────────────────────────────────────
const EXEC_TIMEOUT_MS = Math.max(
  1_000,
  parseInt(process.env.MACHINECTL_EXEC_TIMEOUT || "60000", 10) || 60_000,
);

const execTool = tool(
  "exec_command",
  `Run a shell command and return stdout/stderr/exit. Audited centrally. ` +
    `Timeout ${EXEC_TIMEOUT_MS}ms. If cwd is supplied it must resolve inside ` +
    `MACHINECTL_ALLOWED_PATHS; unset cwd means the daemon's working directory.`,
  {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run (bash -lc)." },
      cwd: { type: "string", description: "Optional working directory (must be inside allowed paths)." },
    },
    required: ["command"],
  },
  z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
  }),
  async ({ command, cwd }) => {
    if (cwd) await assertAllowed(cwd);
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("bash", ["-lc", command], {
        cwd: cwd ?? undefined,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const STDOUT_CAP = 256 * 1024; // 256KB cap to avoid frame bloat
      child.stdout.on("data", (d) => {
        if (stdout.length < STDOUT_CAP) stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < STDOUT_CAP) stderr += d.toString();
      });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`exec_command timed out after ${EXEC_TIMEOUT_MS}ms`));
      }, EXEC_TIMEOUT_MS);
      child.on("close", (code) => {
        clearTimeout(timer);
        const head = `Exit code: ${code ?? "?"}\n`;
        let out = head + stdout;
        if (stderr.trim()) out += "\n--- stderr ---\n" + stderr;
        resolve(out.trim());
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  },
);

// ─── git ─────────────────────────────────────────────────────────────────
// Allow-listed git subcommands. Add more as needed; do NOT add `gc`,
// `clean -fdx`, etc. without thinking about whether the agent could
// nuke uncommitted work. `push` is allowed because that's a primary
// use case ("commit my work, push"). `--force` IS allowed too — same
// reasoning, plus the audit log captures every invocation.
const GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "blame",
  "add", "commit", "checkout", "switch", "branch", "stash",
  "fetch", "pull", "push", "remote",
  "rebase", "merge", "cherry-pick", "reset", "revert",
  "tag", "describe", "config", "rev-parse",
]);

const gitTool = tool(
  "git",
  `Run a git subcommand. cwd defaults to the daemon's directory but must ` +
    `resolve inside MACHINECTL_ALLOWED_PATHS if set. Allowed subcommands: ` +
    [...GIT_SUBCOMMANDS].join(", ") + ".",
  {
    type: "object",
    properties: {
      args: { type: "string", description: 'e.g. "status" or "commit -m \\"fix bug\\""' },
      cwd: { type: "string", description: "Working directory inside allowed paths." },
    },
    required: ["args"],
  },
  z.object({
    args: z.string().min(1),
    cwd: z.string().optional(),
  }),
  async ({ args, cwd }) => {
    if (cwd) await assertAllowed(cwd);
    // First token is the subcommand. Block anything outside the allow-list.
    const trimmed = args.trim();
    const first = trimmed.split(/\s+/)[0];
    if (!GIT_SUBCOMMANDS.has(first)) {
      throw new Error(
        `git subcommand "${first}" is not allow-listed. Allowed: ${[...GIT_SUBCOMMANDS].join(", ")}.`,
      );
    }
    // Delegate to exec for the run.
    return await execTool.handler({ command: `git ${trimmed}`, cwd });
  },
);

// ─── read_file ───────────────────────────────────────────────────────────
const readFileTool = tool(
  "read_file",
  "Read the contents of a file. Path must resolve inside MACHINECTL_ALLOWED_PATHS. " +
    "Returns up to 256KB; larger files are truncated with a notice.",
  {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  z.object({ path: z.string().min(1) }),
  async ({ path }) => {
    const safe = await assertAllowed(path);
    const buf = await fsReadFile(safe);
    const MAX = 256 * 1024;
    if (buf.length > MAX) {
      return buf.subarray(0, MAX).toString("utf-8") +
        `\n\n... (truncated, ${buf.length - MAX} more bytes)`;
    }
    return buf.toString("utf-8");
  },
);

// ─── write_file ──────────────────────────────────────────────────────────
const writeFileTool = tool(
  "write_file",
  "Write content to a file. Path must resolve inside MACHINECTL_ALLOWED_PATHS. " +
    "Creates parent directories as needed. Overwrites by default.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  async ({ path, content }) => {
    const safe = await assertAllowed(path);
    await fsMkdir(dirname(safe), { recursive: true });
    await fsWriteFile(safe, content, "utf-8");
    return `Wrote ${content.length} bytes to ${safe}`;
  },
);

// ─── list_directory ──────────────────────────────────────────────────────
const listDirectoryTool = tool(
  "list_directory",
  "List the contents of a directory. Path must resolve inside MACHINECTL_ALLOWED_PATHS. " +
    "Set `recursive` to true and `maxDepth` (default 3) to walk children.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean", default: false },
      maxDepth: { type: "number", default: 3 },
    },
    required: ["path"],
  },
  z.object({
    path: z.string().min(1),
    recursive: z.boolean().optional().default(false),
    maxDepth: z.number().int().min(1).max(8).optional().default(3),
  }),
  async ({ path, recursive, maxDepth }) => {
    const safe = await assertAllowed(path);
    const out: string[] = [];
    async function walk(dir: string, depth: number) {
      const entries = await fsReaddir(dir, { withFileTypes: true });
      for (const e of entries) {
        const child = pathJoin(dir, e.name);
        const rel = child.slice(safe.length).replace(/^\//, "");
        out.push((e.isDirectory() ? "d " : "f ") + (rel || e.name));
        if (recursive && e.isDirectory() && depth < maxDepth) {
          await walk(child, depth + 1);
        }
      }
    }
    await walk(safe, 1);
    return out.join("\n");
  },
);

// ─── screenshot ──────────────────────────────────────────────────────────
const screenshotTool = tool(
  "screenshot",
  "Capture the active screen. Returns a base64-encoded PNG inline. " +
    "macOS uses screencapture, Linux uses scrot/grim (whichever is installed).",
  { type: "object", properties: {} },
  z.object({}),
  async () => {
    const tmp = pathJoin(tmpdir(), `machinectl-${Date.now()}.png`);
    const plat = platform();
    let cmd: string;
    if (plat === "darwin") cmd = `screencapture -x "${tmp}"`;
    else if (plat === "linux") cmd = `grim "${tmp}" 2>/dev/null || scrot "${tmp}"`;
    else throw new Error(`screenshot not supported on platform "${plat}"`);
    execSync(cmd, { stdio: "ignore" });
    const buf = await fsReadFile(tmp);
    return `data:image/png;base64,${buf.toString("base64")}`;
  },
);

// ─── processes ───────────────────────────────────────────────────────────
const processesTool = tool(
  "processes",
  "List the top N processes by CPU or memory usage.",
  {
    type: "object",
    properties: {
      sortBy: { type: "string", enum: ["cpu", "memory"], default: "cpu" },
      limit: { type: "number", default: 10 },
    },
  },
  z.object({
    sortBy: z.enum(["cpu", "memory"]).optional().default("cpu"),
    limit: z.number().int().min(1).max(50).optional().default(10),
  }),
  async ({ sortBy, limit }) => {
    // BSD ps (macOS) and Linux ps both accept the same -o + --sort syntax
    // for this subset. Column-3 in our format is either %cpu or rss; sort
    // numerically descending on it.
    const col = sortBy === "memory" ? "rss" : "%cpu";
    const cmd = `ps -A -o pid,user,${col},comm,args | sort -k3 -n -r | head -n ${limit + 1}`;
    return execSync(cmd).toString("utf-8");
  },
);

// ─── clipboard ───────────────────────────────────────────────────────────
const clipboardTool = tool(
  "clipboard",
  "Read or write the system clipboard. macOS: pbcopy/pbpaste. Linux: xclip / wl-copy.",
  {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "write"] },
      content: { type: "string", description: "Required when action=write." },
    },
    required: ["action"],
  },
  z.object({
    action: z.enum(["read", "write"]),
    content: z.string().optional(),
  }),
  async ({ action, content }) => {
    const plat = platform();
    if (action === "read") {
      const cmd =
        plat === "darwin" ? "pbpaste" :
        plat === "linux" ? "wl-paste 2>/dev/null || xclip -o -selection clipboard" :
        null;
      if (!cmd) throw new Error(`clipboard not supported on "${plat}"`);
      return execSync(cmd).toString("utf-8");
    }
    if (typeof content !== "string") {
      throw new Error("clipboard write requires content");
    }
    return await new Promise<string>((resolve, reject) => {
      const cmd =
        plat === "darwin" ? "pbcopy" :
        plat === "linux" ? "(wl-copy 2>/dev/null || xclip -selection clipboard)" :
        null;
      if (!cmd) return reject(new Error(`clipboard not supported on "${plat}"`));
      const child = spawn("bash", ["-lc", cmd], { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(content);
      child.on("close", (code) =>
        code === 0 ? resolve(`Wrote ${content.length} chars to clipboard`) : reject(new Error(`clipboard write exited ${code}`)),
      );
      child.on("error", reject);
    });
  },
);

// ─── notify ──────────────────────────────────────────────────────────────
const notifyTool = tool(
  "notify",
  "Send a system notification. macOS: osascript. Linux: notify-send.",
  {
    type: "object",
    properties: {
      title: { type: "string" },
      message: { type: "string" },
    },
    required: ["title", "message"],
  },
  z.object({
    title: z.string().min(1),
    message: z.string().min(1),
  }),
  async ({ title, message }) => {
    const plat = platform();
    if (plat === "darwin") {
      // Escape quotes for osascript.
      const t = title.replace(/"/g, '\\"');
      const m = message.replace(/"/g, '\\"');
      execSync(`osascript -e 'display notification "${m}" with title "${t}"'`);
    } else if (plat === "linux") {
      execSync(`notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`);
    } else {
      throw new Error(`notify not supported on "${plat}"`);
    }
    return `Sent notification: ${title}`;
  },
);

// ─── open ────────────────────────────────────────────────────────────────
const openTool = tool(
  "open",
  "Open a URL or file in the system's default handler. macOS: open. Linux: xdg-open.",
  {
    type: "object",
    properties: {
      target: { type: "string", description: "URL or absolute file path." },
    },
    required: ["target"],
  },
  z.object({
    target: z.string().min(1),
  }),
  async ({ target }) => {
    // If it looks like a path (not a URL), gate on allowed paths.
    const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(target);
    if (!isUrl) {
      await assertAllowed(target);
    }
    const plat = platform();
    const cmd = plat === "darwin" ? "open" : "xdg-open";
    execSync(`${cmd} ${JSON.stringify(target)}`);
    return `Opened: ${target}`;
  },
);

// ─── exposed registry ────────────────────────────────────────────────────

/** Build the registry, filtering out tools whose preconditions aren't
 *  met. The exec_command and git tools register unconditionally because
 *  cwd is optional; if the caller omits it, the daemon runs in its own
 *  PWD (which is left to the user — typical pattern is to start the
 *  daemon inside the allowed paths root). Filesystem tools only register
 *  when ALLOWED_PATHS is non-empty. */
export function buildToolRegistry(): RegisteredTool[] {
  const out: RegisteredTool[] = [];
  out.push(execTool);
  out.push(gitTool);
  out.push(...buildAgentSessionTools());
  if (FS_TOOLS_AVAILABLE) {
    out.push(readFileTool);
    out.push(writeFileTool);
    out.push(listDirectoryTool);
  }
  out.push(screenshotTool);
  out.push(processesTool);
  out.push(clipboardTool);
  out.push(notifyTool);
  out.push(openTool);
  return out;
}
