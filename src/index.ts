import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const execAsync = promisify(exec);

// Config
const PORT = parseInt(process.env.PORT || "7331");
const MACHINECTL_TOKEN = process.env.MACHINECTL_TOKEN; // Optional - if not set, no auth required
const MACHINECTL_ALLOWED_PATHS = (process.env.MACHINECTL_ALLOWED_PATHS || os.homedir()).split(",").map(p => path.resolve(p));
const MACHINECTL_ALLOWED_ORIGINS = process.env.MACHINECTL_ALLOWED_ORIGINS?.split(",") || ["*.trycloudflare.com"];
const MACHINECTL_TUNNEL = process.env.MACHINECTL_TUNNEL; // false=disabled, name=named tunnel, unset=quick tunnel
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_REQUEST_BODY = 1024 * 1024; // 1MB
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT || "60000");

// Tunnel state
let tunnelUrl: string | null = null;
let tunnelProcess: ReturnType<typeof spawn> | null = null;

// Response helpers
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const err = (t: string) => ({ ...text(t), isError: true });

// Path validation
const isPathAllowed = (filePath: string): boolean => {
  const resolved = path.resolve(filePath);
  return MACHINECTL_ALLOWED_PATHS.some(allowed => resolved.startsWith(path.resolve(allowed)));
};

const validatePath = (filePath: string): { valid: boolean; error?: string } => {
  if (!isPathAllowed(filePath)) {
    return { valid: false, error: `Path outside allowed directories: ${filePath}` };
  }
  return { valid: true };
};

// Auth check helper
const checkAuth = (token: string | undefined): boolean => {
  if (!MACHINECTL_TOKEN) return true;
  return token === MACHINECTL_TOKEN;
};

// CORS config
const corsOptions = {
  origin: (origin: string, c: any): string | null => {
    if (!origin) return origin;
    const allowed = MACHINECTL_ALLOWED_ORIGINS.some(allowedPattern => {
      if (allowedPattern.startsWith("*.")) {
        const domain = allowedPattern.slice(2);
        return origin.endsWith(domain);
      }
      return origin === allowedPattern;
    });
    return allowed ? origin : null;
  },
};

// Create MCP server
const mcpServer = new McpServer({
  name: "machinectl",
  version: "0.3.0",
});

// Track child processes for cleanup
const childProcesses = new Map<number, NodeJS.Process>();

// Action log system
interface ActionLog {
  id: string;
  timestamp: Date;
  tool: string;
  args: Record<string, any>;
  result: string;
  isError: boolean;
  durationMs: number;
}

const actionLogs: ActionLog[] = [];
const MAX_LOGS = 1000;
const logSubscribers = new Set<(log: ActionLog) => void>();

// Helper to wrap any tool handler with logging
const withLogging = <T extends Record<string, any>>(
  toolName: string,
  handler: (args: T) => Promise<any>
) => async (args: T) => {
  const id = crypto.randomUUID();
  const start = Date.now();
  try {
    const result = await handler(args);
    const resultStr = typeof result === 'string'
      ? result.slice(0, 1000)
      : JSON.stringify(result).slice(0, 1000);
    const log: ActionLog = {
      id,
      timestamp: new Date(),
      tool: toolName,
      args,
      result: resultStr,
      isError: false,
      durationMs: Date.now() - start,
    };
    actionLogs.push(log);
    if (actionLogs.length > MAX_LOGS) actionLogs.shift();
    logSubscribers.forEach((cb) => cb(log));
    return result;
  } catch (e: any) {
    const errorMsg = e?.message || String(e);
    const log: ActionLog = {
      id,
      timestamp: new Date(),
      tool: toolName,
      args,
      result: errorMsg.slice(0, 1000),
      isError: true,
      durationMs: Date.now() - start,
    };
    actionLogs.push(log);
    if (actionLogs.length > MAX_LOGS) actionLogs.shift();
    logSubscribers.forEach((cb) => cb(log));
    throw e;
  }
};

// Get hostname from cloudflared config for named tunnels
const getNamedTunnelHostname = async (): Promise<string | null> => {
  try {
    const configPath = path.join(os.homedir(), ".cloudflared", "config.yml");
    const config = await fs.readFile(configPath, "utf-8");
    const hostnameMatch = config.match(/hostname:\s*([^\s]+)/);
    return hostnameMatch ? `https://${hostnameMatch[1]}` : null;
  } catch {
    return null;
  }
};

// Start tunnel
const startTunnel = async () => {
  if (MACHINECTL_TUNNEL === "false") {
    return; // Tunnel disabled
  }

  const isNamedTunnel = MACHINECTL_TUNNEL && MACHINECTL_TUNNEL !== "false";
  const args = isNamedTunnel
    ? ["tunnel", "run", MACHINECTL_TUNNEL]
    : ["tunnel", "--url", `http://localhost:${PORT}`];

  // For named tunnels, try to get hostname from config
  if (isNamedTunnel) {
    const hostname = await getNamedTunnelHostname();
    if (hostname) {
      tunnelUrl = hostname;
      console.log(`\nTunnel ready: ${tunnelUrl}`);
      console.log(`MCP endpoint: ${tunnelUrl}/mcp${MACHINECTL_TOKEN ? `/${MACHINECTL_TOKEN}` : ""}`);
    } else {
      console.log(`\nTunnel running (check your Cloudflare config for the hostname)`);
    }
  }

  tunnelProcess = spawn("cloudflared", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  childProcesses.set(tunnelProcess.pid!, tunnelProcess as any);

  // Parse tunnel URL from stderr (cloudflared outputs it there for quick tunnels)
  tunnelProcess.stderr?.on("data", (data) => {
    const line = data.toString();
    // Log tunnel output so user can see it's working
    if (isNamedTunnel) {
      process.stderr.write(data);
    }
    const match = line.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
    if (match) {
      tunnelUrl = match[0];
      console.log(`\nTunnel ready: ${tunnelUrl}`);
      console.log(`MCP endpoint: ${tunnelUrl}/mcp${MACHINECTL_TOKEN ? `/${MACHINECTL_TOKEN}` : ""}`);
    }
  });

  tunnelProcess.on("error", (error) => {
    console.error(`Failed to start tunnel: ${error.message}`);
    console.error("Make sure cloudflared is installed: brew install cloudflared");
  });

  tunnelProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Tunnel exited with code ${code}`);
    }
    childProcesses.delete(tunnelProcess!.pid!);
  });
};

// Exec with proper cleanup
const execWithCleanup = async (command: string, options: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    childProcesses.set(child.pid!, child as any);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    const timeout = setTimeout(() => {
      try {
        process.kill(-child.pid!);
      } catch { }
      childProcesses.delete(child.pid!);
      reject(new Error("Command timeout"));
    }, options.timeout || EXEC_TIMEOUT);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      childProcesses.delete(child.pid!);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error: any = new Error(`Command failed with exit code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      childProcesses.delete(child.pid!);
      reject(error);
    });
  });
};

// Detect binary file
const isBinaryFile = (filePath: string): boolean => {
  const ext = path.extname(filePath).toLowerCase();
  const binaryExts = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".dylib"];
  return binaryExts.includes(ext);
};

// Screenshot tool
mcpServer.registerTool("screenshot", {
  description: "Capture a screenshot of the entire screen. Returns base64-encoded PNG.",
}, withLogging("screenshot", async () => {
  const tempPath = path.join(os.tmpdir(), `machinectl-screenshot-${crypto.randomUUID()}.png`);
  const platform = os.platform();

  try {
    if (platform === "darwin") {
      await execAsync(`screencapture -x "${tempPath}"`);
    } else if (platform === "linux") {
      await execAsync(`scrot "${tempPath}"`);
    } else {
      return err("Screenshot not supported on this platform");
    }

    await fs.chmod(tempPath, 0o600);
    const buffer = await fs.readFile(tempPath);
    await fs.unlink(tempPath).catch(() => { });

    return {
      content: [
        {
          type: "image",
          data: buffer.toString("base64"),
          mimeType: "image/png",
        },
      ],
    };
  } catch (error) {
    return err(`Screenshot failed: ${error}`);
  }
}));

// Exec tool
mcpServer.registerTool("exec", {
  description: "Execute a shell command. Returns stdout, stderr, and exit code.",
  inputSchema: {
    command: z.string().describe("The shell command to execute"),
    cwd: z.string().optional().describe("Working directory (optional)"),
  },
}, withLogging("exec", async ({ command, cwd }) => {
  try {
    if (cwd && !validatePath(cwd).valid) {
      return err(`Working directory outside allowed paths: ${cwd}`);
    }

    const { stdout, stderr } = await execWithCleanup(command, { cwd, timeout: EXEC_TIMEOUT });
    const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
    return text(output || "(no output)");
  } catch (error: any) {
    const output = (error.stdout || "") + (error.stderr ? `\n[stderr]\n${error.stderr}` : "");
    return err(output || `Command failed: ${error.message}`);
  }
}));

// Read file tool
mcpServer.registerTool("read_file", {
  description: "Read the contents of a file",
  inputSchema: {
    path: z.string().describe("Absolute path to the file"),
  },
}, withLogging("read_file", async ({ path: filePath }) => {
  try {
    const validation = validatePath(filePath);
    if (!validation.valid) {
      return err(validation.error!);
    }

    const stats = await fs.stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      return err(`File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
    }

    if (isBinaryFile(filePath)) {
      const buffer = await fs.readFile(filePath);
      return {
        content: [
          {
            type: "text",
            text: `Binary file (${stats.size} bytes). Base64: ${buffer.toString("base64")}`,
          },
        ],
      };
    }

    const content = await fs.readFile(filePath, "utf-8");
    return text(content);
  } catch (error) {
    return err(`Failed to read file: ${error}`);
  }
}));

// Write file tool
mcpServer.registerTool("write_file", {
  description: "Write content to a file. Creates parent directories if needed.",
  inputSchema: {
    path: z.string().describe("Absolute path to the file"),
    content: z.string().describe("Content to write"),
  },
}, withLogging("write_file", async ({ path: filePath, content }) => {
  try {
    const validation = validatePath(filePath);
    if (!validation.valid) {
      return err(validation.error!);
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    return text(`Written ${content.length} bytes to ${filePath}`);
  } catch (error) {
    return err(`Failed to write file: ${error}`);
  }
}));

// List directory tool
mcpServer.registerTool("list_directory", {
  description: "List files and directories in a path",
  inputSchema: {
    path: z.string().describe("Absolute path to the directory"),
    recursive: z.boolean().optional().describe("List recursively (default: false, max depth: 3)"),
  },
}, withLogging("list_directory", async ({ path: dirPath, recursive }) => {
  try {
    const validation = validatePath(dirPath);
    if (!validation.valid) {
      return err(validation.error!);
    }

    let totalEntries = 0;
    const MAX_ENTRIES = 1000;

    const listDir = async (dir: string, depth: number = 0): Promise<string[]> => {
      if (depth > 3 || totalEntries >= MAX_ENTRIES) return [];

      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results: string[] = [];

      const entryPromises = entries.map(async (entry) => {
        if (entry.name.startsWith(".") || entry.name === "node_modules") return null;

        const fullPath = path.join(dir, entry.name);

        // Skip symlinks
        try {
          const stat = await fs.lstat(fullPath);
          if (stat.isSymbolicLink()) return null;
        } catch { }

        totalEntries++;
        if (totalEntries > MAX_ENTRIES) return null;

        const prefix = entry.isDirectory() ? "[dir]  " : "[file] ";
        const result = `${prefix}${fullPath}`;

        if (recursive && entry.isDirectory()) {
          const children = await listDir(fullPath, depth + 1);
          return [result, ...children];
        }

        return result;
      });

      const resolved = await Promise.all(entryPromises);
      return resolved.flat().filter((x): x is string => x !== null);
    };

    const entries = await listDir(dirPath);
    return text(entries.join("\n") || "(empty)");
  } catch (error) {
    return err(`Failed to list directory: ${error}`);
  }
}));

// Git tool
mcpServer.registerTool("git", {
  description: "Run git commands. Examples: 'status', 'diff', 'log -5', 'add .', 'commit -m \"message\"'",
  inputSchema: {
    args: z.string().describe("Git command arguments (without 'git' prefix)"),
    cwd: z.string().optional().describe("Repository directory (optional)"),
  },
}, withLogging("git", async ({ args, cwd }) => {
  try {
    if (cwd && !validatePath(cwd).valid) {
      return err(`Working directory outside allowed paths: ${cwd}`);
    }

    const { stdout, stderr } = await execWithCleanup(`git ${args}`, { cwd, timeout: EXEC_TIMEOUT });
    return text(stdout || stderr || "(no output)");
  } catch (error: any) {
    const output = (error.stdout || "") + (error.stderr ? `\n[stderr]\n${error.stderr}` : "");
    return err(output || error.message);
  }
}));

// Clipboard tool
mcpServer.registerTool("clipboard", {
  description: "Read or write system clipboard. Platform: macOS (pbpaste/pbcopy), Linux (xclip).",
  inputSchema: {
    action: z.enum(["read", "write"]).describe("Action to perform"),
    content: z.string().optional().describe("Content to write (required for write action)"),
  },
}, withLogging("clipboard", async ({ action, content }) => {
  const platform = os.platform();

  if (action === "read") {
    const cmd = platform === "darwin"
      ? "pbpaste"
      : platform === "linux"
        ? "xclip -selection clipboard -o"
        : null;
    if (!cmd) {
      return err("Clipboard read not supported on this platform");
    }
    try {
      const { stdout } = await execAsync(cmd);
      return text(stdout);
    } catch (error) {
      return err(`Failed to read clipboard: ${error}`);
    }
  } else {
    if (!content) {
      return err("Content is required for write action");
    }
    // Use spawn with stdin for proper content handling
    const writeCmd = platform === "darwin" ? "pbcopy" : platform === "linux" ? "xclip -selection clipboard" : null;
    if (!writeCmd) {
      return err("Clipboard write not supported on this platform");
    }
    try {
      const child = spawn("/bin/sh", ["-c", writeCmd], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin?.write(content);
      child.stdin?.end();

      await new Promise<void>((resolve, reject) => {
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Command failed with code ${code}`));
        });
        child.on("error", reject);
      });

      return text("Copied to clipboard");
    } catch (error) {
      return err(`Failed to write clipboard: ${error}`);
    }
  }
}));

// Notification tool
mcpServer.registerTool("notify", {
  description: "Send a system notification. Platform: macOS (osascript), Linux (notify-send).",
  inputSchema: {
    title: z.string().describe("Notification title"),
    message: z.string().describe("Notification message"),
  },
}, withLogging("notify", async ({ title, message }) => {
  const platform = os.platform();
  const cmd = platform === "darwin"
    ? `osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`
    : platform === "linux"
      ? `notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`
      : null;

  if (!cmd) {
    return err("Notifications not supported on this platform");
  }

  try {
    await execAsync(cmd);
    return text("Notification sent");
  } catch (error) {
    return err(`Failed to send notification: ${error}`);
  }
}));

// Processes tool
mcpServer.registerTool("processes", {
  description: "List top processes by CPU or memory usage. Useful for debugging performance issues.",
  inputSchema: {
    sortBy: z.enum(["cpu", "memory"]).default("cpu").describe("Sort by CPU or memory usage"),
    limit: z.number().default(10).describe("Number of processes to return"),
  },
}, withLogging("processes", async ({ sortBy, limit }) => {
  try {
    const flag = sortBy === "cpu" ? "-%cpu" : "-%mem";
    const { stdout } = await execAsync(`ps aux --sort=${flag} | head -${limit + 1}`);
    return text(stdout);
  } catch (error) {
    return err(`Failed to list processes: ${error}`);
  }
}));

// Hono app with SSE transport
const app = new Hono<{ Bindings: HttpBindings }>();

// CORS
app.use("*", cors(corsOptions));

// Body size limit middleware
app.use("*", async (c, next) => {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength) > MAX_REQUEST_BODY) {
    return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});

// Single transport instance
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});
await mcpServer.connect(transport);

// Health check
app.get("/health", (c) => {
  const authed = checkAuth(undefined);
  return c.json({ status: "ok", version: "0.3.0", authed });
});

// Logs API endpoints
app.get("/api/logs", (c) => {
  const limit = parseInt(c.req.query("limit") || "50");
  const logs = actionLogs.slice(-limit);
  return c.json(logs);
});

app.get("/api/logs/stream", (c) => {
  let handler: ((log: ActionLog) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial connection message
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));

      // Send existing logs
      actionLogs.slice(-50).forEach((log) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(log)}\n\n`));
      });

      // Subscribe to new logs
      handler = (log: ActionLog) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(log)}\n\n`));
        } catch (e) {
          // Client disconnected
          if (handler) logSubscribers.delete(handler);
        }
      };

      logSubscribers.add(handler);
    },
    cancel() {
      // Cleanup on cancel
      if (handler) {
        logSubscribers.delete(handler);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

app.post("/api/logs/export", (c) => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    totalActions: actionLogs.length,
    logs: actionLogs,
  };

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="machinectl-session-${Date.now()}.json"`,
    },
  });
});

// Dashboard UI
app.get("/ui", (c) => {
  const mcpEndpoint = tunnelUrl
    ? `${tunnelUrl}/mcp${MACHINECTL_TOKEN ? `/${MACHINECTL_TOKEN}` : ""}`
    : `http://localhost:${PORT}/mcp${MACHINECTL_TOKEN ? `/${MACHINECTL_TOKEN}` : ""}`;

  return c.html(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>machinectl</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      padding: 2rem;
      line-height: 1.6;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #fff; margin-bottom: 2rem; font-size: 2rem; }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1rem;
    }
    .status {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 4px;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 1rem;
    }
    .status.running { background: #10b981; color: #fff; }
    .status.connecting { background: #f59e0b; color: #fff; }
    .status.local { background: #6b7280; color: #fff; }
    code {
      background: #0a0a0a;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 0.875rem;
      color: #60a5fa;
      word-break: break-all;
    }
    .url-container {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-top: 0.5rem;
    }
    button {
      background: #3b82f6;
      color: #fff;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      transition: background 0.2s;
    }
    button:hover { background: #2563eb; }
    button:active { background: #1d4ed8; }
    .label { color: #9ca3af; font-size: 0.875rem; margin-bottom: 0.25rem; }
    .value { margin-bottom: 1rem; }
    .activity-feed {
      max-height: 600px;
      overflow-y: auto;
    }
    .activity-item {
      padding: 0.75rem;
      border-bottom: 1px solid #2a2a2a;
      font-size: 0.875rem;
    }
    .activity-item:last-child { border-bottom: none; }
    .activity-item.error { border-left: 3px solid #ef4444; padding-left: calc(0.75rem - 3px); }
    .activity-item.success { border-left: 3px solid #10b981; padding-left: calc(0.75rem - 3px); }
    .activity-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.25rem;
    }
    .activity-tool {
      font-weight: 600;
      color: #60a5fa;
    }
    .activity-time {
      color: #6b7280;
      font-size: 0.75rem;
    }
    .activity-args {
      color: #9ca3af;
      font-size: 0.75rem;
      margin-top: 0.25rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .activity-result {
      color: #d1d5db;
      font-size: 0.75rem;
      margin-top: 0.25rem;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 100px;
      overflow-y: auto;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>machinectl</h1>
    
    <div class="grid">
      <div>
        <div class="card">
          <div class="status ${tunnelUrl ? 'running' : (MACHINECTL_TUNNEL === 'false' ? 'local' : 'connecting')}">
            ${tunnelUrl ? 'Running' : (MACHINECTL_TUNNEL === 'false' ? 'Local Only' : 'Connecting...')}
          </div>
          
          <div class="value">
            <div class="label">MCP Endpoint</div>
            <div class="url-container">
              <code id="mcp-url">${mcpEndpoint}</code>
              <button onclick="copyUrl()">Copy</button>
            </div>
          </div>
          
          ${tunnelUrl ? `
          <div class="value">
            <div class="label">Tunnel URL</div>
            <code>${tunnelUrl}</code>
          </div>
          ` : ''}
          
          <div class="value">
            <div class="label">Allowed Paths</div>
            <code>${MACHINECTL_ALLOWED_PATHS.join(", ")}</code>
          </div>
          
          <div class="value">
            <div class="label">Auth</div>
            <code>${MACHINECTL_TOKEN ? "enabled (token in URL path)" : "disabled"}</code>
          </div>
          
          <div class="value">
            <button onclick="exportSession()">Export Session</button>
          </div>
        </div>
      </div>
      
      <div>
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
            <h2 style="font-size: 1.25rem; color: #fff;">Activity Feed</h2>
            <span id="log-count" style="color: #6b7280; font-size: 0.875rem;">0 actions</span>
          </div>
          <div class="activity-feed" id="activity-feed">
            <div style="text-align: center; color: #6b7280; padding: 2rem;">
              Waiting for activity...
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    function copyUrl() {
      const url = document.getElementById('mcp-url').textContent;
      navigator.clipboard.writeText(url).then(() => {
        const btn = event.target;
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 2000);
      });
    }
    
    function exportSession() {
      fetch('/api/logs/export')
        .then(res => res.blob())
        .then(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'machinectl-session-' + Date.now() + '.json';
          a.click();
          URL.revokeObjectURL(url);
        });
    }
    
    function formatTime(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleTimeString();
    }
    
    function truncate(str, maxLen) {
      if (str.length <= maxLen) return str;
      return str.slice(0, maxLen) + '...';
    }
    
    function addActivityItem(log) {
      const feed = document.getElementById('activity-feed');
      if (feed.children.length === 1 && feed.children[0].textContent.includes('Waiting')) {
        feed.innerHTML = '';
      }
      
      const item = document.createElement('div');
      item.className = 'activity-item ' + (log.isError ? 'error' : 'success');
      
      const argsStr = JSON.stringify(log.args, null, 2);
      const resultStr = typeof log.result === 'string' ? log.result : JSON.stringify(log.result);
      
      item.innerHTML = \`
        <div class="activity-header">
          <span class="activity-tool">\${log.tool}</span>
          <span class="activity-time">\${formatTime(log.timestamp)} (\${log.durationMs}ms)</span>
        </div>
        <div class="activity-args">\${truncate(argsStr, 200)}</div>
        <div class="activity-result">\${truncate(resultStr, 500)}</div>
      \`;
      
      feed.insertBefore(item, feed.firstChild);
      
      // Keep only last 50 items
      while (feed.children.length > 50) {
        feed.removeChild(feed.lastChild);
      }
      
      // Update count
      document.getElementById('log-count').textContent = \`\${feed.children.length} action\${feed.children.length !== 1 ? 's' : ''}\`;
    }
    
    // Connect to SSE stream
    const eventSource = new EventSource('/api/logs/stream');
    eventSource.onmessage = (e) => {
      try {
        const log = JSON.parse(e.data);
        if (log.type !== 'connected') {
          addActivityItem(log);
        }
      } catch (err) {
        console.error('Failed to parse log:', err);
      }
    };
    
    eventSource.onerror = () => {
      console.error('SSE connection error');
    };
    
    // Load initial logs
    fetch('/api/logs?limit=50')
      .then(res => res.json())
      .then(logs => {
        logs.reverse().forEach(log => addActivityItem(log));
      });
    
    // Auto-refresh if connecting
    ${!tunnelUrl && MACHINECTL_TUNNEL !== 'false' ? `
    setTimeout(() => { location.reload(); }, 2000);
    ` : ''}
  </script>
</body>
</html>
  `);
});

// MCP endpoint with token in path: /mcp/:token
app.all("/mcp/:token", async (c) => {
  const token = c.req.param("token");
  if (!checkAuth(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { incoming, outgoing } = c.env;
  try {
    const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT;
  } catch (error) {
    if (!outgoing.headersSent) {
      return c.json({ error: "Internal server error" }, 500);
    }
    return RESPONSE_ALREADY_SENT;
  }
});

// MCP endpoint without token (for when MACHINECTL_TOKEN is not set)
app.all("/mcp", async (c) => {
  if (!checkAuth(undefined)) {
    return c.json({ error: "Unauthorized - use /mcp/:token" }, 401);
  }

  const { incoming, outgoing } = c.env;
  try {
    const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT;
  } catch (error) {
    if (!outgoing.headersSent) {
      return c.json({ error: "Internal server error" }, 500);
    }
    return RESPONSE_ALREADY_SENT;
  }
});

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...");
  transport.close?.();

  // Kill tunnel process
  if (tunnelProcess) {
    try {
      tunnelProcess.kill();
    } catch { }
  }

  // Kill all child processes
  for (const [pid] of childProcesses.entries()) {
    try {
      process.kill(-pid);
    } catch { }
  }

  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Start server with Node.js adapter
serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`machinectl running on http://localhost:${PORT}`);
console.log(`Dashboard: http://localhost:${PORT}/ui`);
console.log(`MCP endpoint: http://localhost:${PORT}/mcp${MACHINECTL_TOKEN ? `/${MACHINECTL_TOKEN}` : ""}`);
console.log(`Auth: ${MACHINECTL_TOKEN ? "enabled (token in URL path)" : "disabled"}`);
console.log(`Allowed paths: ${MACHINECTL_ALLOWED_PATHS.join(", ")}`);

// Start tunnel if enabled
if (MACHINECTL_TUNNEL !== "false") {
  if (MACHINECTL_TUNNEL) {
    console.log(`\nStarting named tunnel: ${MACHINECTL_TUNNEL}`);
  } else {
    console.log(`\nStarting quick tunnel...`);
  }
  await startTunnel();
} else {
  console.log(`\nTunnel disabled (MACHINECTL_TUNNEL=false)`);
}
