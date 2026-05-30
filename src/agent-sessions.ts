// agent-sessions.ts — local coding-agent session control.
//
// Pi runs through its structured JSONL RPC protocol and remains steerable.
// OpenCode runs as a captured bounded job. Every session begins within an
// explicitly allowed project root, is resource bounded, and is torn down when
// the machinectl daemon exits.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve as pathResolve } from "node:path";
import { z } from "zod";
import type { RegisteredTool, ToolHandler } from "./protocol.js";

const OUTPUT_CAP = 512 * 1024;
const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = boundedInt("MACHINECTL_AGENT_MAX_SESSIONS", 4, 1, 32);
const SESSION_MAX_RUNTIME_MS = boundedInt("MACHINECTL_AGENT_MAX_RUNTIME_MS", 2 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
const STOP_GRACE_MS = boundedInt("MACHINECTL_AGENT_STOP_GRACE_MS", 5_000, 100, 60_000);
const PI_CONTROL_COMMANDS = [
  "get_state", "get_messages", "get_session_stats", "get_last_assistant_text", "get_commands", "get_available_models",
  "set_model", "set_thinking_level", "compact", "set_auto_compaction", "set_auto_retry", "new_session", "switch_session",
  "fork", "clone", "get_fork_messages", "set_session_name", "export_html",
] as const;

type AgentKind = "pi" | "opencode";
type Status = "idle" | "running" | "stopping" | "stopped" | "exited" | "error" | "timed_out";
type PiControlCommand = typeof PI_CONTROL_COMMANDS[number];

type Session = {
  id: string;
  agent: AgentKind;
  cwd: string;
  title?: string;
  command: string[];
  process: ChildProcessWithoutNullStreams;
  status: Status;
  startedAt: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  output: string;
  events: unknown[];
  responseWaiters: Map<string, { resolve: (response: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
  lifetimeTimer: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
};

type PersistedPiSession = {
  source: "disk";
  sessionId: string;
  sessionFile: string;
  cwd: string;
  name: string | null;
  modifiedAt: string;
};

const sessions = new Map<string, Session>();
const configuredRoots = (process.env.MACHINECTL_ALLOWED_PATHS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((root) => pathResolve(root));
const hasConfiguredPathRoots = configuredRoots.length > 0;
let cachedCanonicalRoots: Promise<string[]> | undefined;

function boundedInt(envName: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[envName] ?? "", 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

async function canonicalRoots(): Promise<string[]> {
  cachedCanonicalRoots ??= Promise.all(configuredRoots.map(async (root) => fsRealpath(root).catch(() => root)));
  return cachedCanonicalRoots;
}

function capAppend(existing: string, addition: string): string {
  const combined = existing + addition;
  return combined.length <= OUTPUT_CAP ? combined : combined.slice(combined.length - OUTPUT_CAP);
}

function isTerminalStatus(status: Status): boolean {
  return status === "stopped" || status === "exited" || status === "error" || status === "timed_out";
}

function trimFinishedSessions() {
  const cutoff = Date.now() - FINISHED_RETENTION_MS;
  for (const [id, session] of sessions) {
    if (isTerminalStatus(session.status) && session.updatedAt < cutoff) sessions.delete(id);
  }
}

function activeSessionCount(): number {
  trimFinishedSessions();
  return [...sessions.values()].filter((session) => !isTerminalStatus(session.status)).length;
}

function assertCapacity() {
  if (activeSessionCount() >= MAX_SESSIONS) {
    throw new Error(`Maximum concurrent agent sessions reached (${MAX_SESSIONS}). Stop an existing session before starting another.`);
  }
}

async function requireAllowedPath(path: string, label: string): Promise<string> {
  if (!hasConfiguredPathRoots) {
    throw new Error(`MACHINECTL_ALLOWED_PATHS is empty; ${label} requires an explicitly allowed path.`);
  }
  const resolved = pathResolve(path);
  const canonical = await fsRealpath(resolved).catch(() => resolved);
  const roots = await canonicalRoots();
  const allowed = roots.some((root) => canonical === root || canonical.startsWith(root + "/"));
  if (!allowed) throw new Error(`${label} "${path}" is outside MACHINECTL_ALLOWED_PATHS (${roots.join(", ")}).`);
  return canonical;
}

async function requireCwd(path: string): Promise<string> {
  const canonical = await fsRealpath(pathResolve(path)).catch(() => {
    throw new Error(`cwd does not exist: ${path}`);
  });
  await requireAllowedPath(canonical, "cwd");
  await access(canonical);
  return canonical;
}

function mustGetSession(id: string): Session {
  trimFinishedSessions();
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown agent session: ${id}`);
  return session;
}

function publicSession(session: Session) {
  return {
    id: session.id,
    agent: session.agent,
    cwd: session.cwd,
    title: session.title ?? null,
    status: session.status,
    pid: session.process.pid ?? null,
    command: session.command,
    startedAt: new Date(session.startedAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    exitCode: session.exitCode ?? null,
    signal: session.signal ?? null,
    error: session.error ?? null,
    maxRuntimeMs: SESSION_MAX_RUNTIME_MS,
  };
}

function pushEvent(session: Session, event: unknown) {
  session.events.push(event);
  if (session.events.length > 500) session.events.splice(0, session.events.length - 500);
  session.updatedAt = Date.now();
  if (typeof event !== "object" || event === null) return;
  const obj = event as Record<string, unknown>;
  if (obj.type === "agent_start") session.status = "running";
  if (obj.type === "agent_end") session.status = "idle";
  if (obj.type === "response" && typeof obj.id === "string") {
    const waiter = session.responseWaiters.get(obj.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      session.responseWaiters.delete(obj.id);
      waiter.resolve(event);
    }
  }
}

function signalProcessTree(session: Session, signal: NodeJS.Signals) {
  const pid = session.process.pid;
  if (!pid || session.process.exitCode !== null) return;
  if (process.platform === "win32") {
    session.process.kill(signal);
    return;
  }
  try { process.kill(-pid, signal); } catch { try { session.process.kill(signal); } catch { /* already dead */ } }
}

function stopSession(session: Session, terminalStatus: "stopped" | "timed_out", reason?: string) {
  if (isTerminalStatus(session.status)) return;
  session.status = terminalStatus;
  session.updatedAt = Date.now();
  if (reason) session.error = reason;
  signalProcessTree(session, "SIGTERM");
  session.killTimer ??= setTimeout(() => signalProcessTree(session, "SIGKILL"), STOP_GRACE_MS);
}

export function shutdownAgentSessions(reason = "machinectl daemon shutting down") {
  for (const session of sessions.values()) {
    if (!isTerminalStatus(session.status)) stopSession(session, "stopped", reason);
  }
}

function attachOutput(session: Session) {
  let stdoutBuffer = "";
  session.process.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    session.output = capAppend(session.output, text);
    session.updatedAt = Date.now();
    if (session.agent !== "pi") return;
    stdoutBuffer += text;
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try { pushEvent(session, JSON.parse(line)); } catch { pushEvent(session, { type: "stdout", text: line }); }
    }
  });
  session.process.stderr.on("data", (chunk: Buffer) => {
    session.output = capAppend(session.output, `\n[stderr] ${chunk.toString("utf-8")}`);
    session.updatedAt = Date.now();
  });
  session.process.on("error", (err) => {
    if (!isTerminalStatus(session.status)) session.status = "error";
    session.error = err.message;
    session.updatedAt = Date.now();
  });
  session.process.on("close", (code, signal) => {
    clearTimeout(session.lifetimeTimer);
    if (session.killTimer) clearTimeout(session.killTimer);
    if (!isTerminalStatus(session.status)) session.status = "exited";
    session.exitCode = code;
    session.signal = signal;
    session.updatedAt = Date.now();
    for (const waiter of session.responseWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Agent process exited before replying (code ${code ?? "?"})`));
    }
    session.responseWaiters.clear();
  });
}

function registerProcess(agent: AgentKind, cwd: string, title: string | undefined, command: string[]): Session {
  assertCapacity();
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: processEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const session = {} as Session;
  Object.assign(session, {
    id: randomUUID(), agent, cwd, title, command, process: child, status: agent === "pi" ? "idle" : "running",
    startedAt: Date.now(), updatedAt: Date.now(), output: "", events: [], responseWaiters: new Map(),
    lifetimeTimer: setTimeout(() => stopSession(session, "timed_out", `Agent session exceeded maximum runtime of ${SESSION_MAX_RUNTIME_MS}ms.`), SESSION_MAX_RUNTIME_MS),
  });
  sessions.set(session.id, session);
  attachOutput(session);
  return session;
}

function sendPi(session: Session, command: Record<string, unknown>, waitMs = 10_000): Promise<unknown> {
  if (session.agent !== "pi") throw new Error("This operation is only supported for pi RPC sessions.");
  if (isTerminalStatus(session.status) || session.status === "stopping") throw new Error(`pi session ${session.id} is ${session.status}`);
  const id = randomUUID();
  const framed = { ...command, id };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.responseWaiters.delete(id);
      reject(new Error(`Timed out waiting for pi response to ${String(command.type)}`));
    }, waitMs);
    session.responseWaiters.set(id, { resolve, reject, timer });
    session.process.stdin.write(JSON.stringify(framed) + "\n", (err) => {
      if (!err) return;
      clearTimeout(timer);
      session.responseWaiters.delete(id);
      reject(err);
    });
  });
}

async function validateSessionReference(reference: string, cwd: string): Promise<string> {
  if (!isAbsolute(reference) && !reference.includes("/")) return reference; // pi partial UUID lookup remains scoped by cwd.
  const sessionPath = await requireAllowedPath(reference, "pi session path");
  const first = await fsReadFile(sessionPath, "utf-8").then((content) => content.split("\n", 1)[0]).catch(() => "");
  try {
    const header = JSON.parse(first) as { cwd?: string };
    if (header.cwd) await requireAllowedPath(header.cwd, "pi session cwd");
  } catch { /* pi will validate session format; path gating already succeeded */ }
  await requireAllowedPath(cwd, "cwd");
  return sessionPath;
}

async function startPi(args: { cwd: string; prompt?: string; title?: string; model?: string; thinking?: string; continueRecent?: boolean; session?: string }): Promise<Session> {
  const cwd = await requireCwd(args.cwd);
  const command = ["pi", "--mode", "rpc"];
  if (args.model) command.push("--model", args.model);
  if (args.thinking) command.push("--thinking", args.thinking);
  if (args.session) command.push("--session", await validateSessionReference(args.session, cwd));
  else if (args.continueRecent) command.push("--continue");
  const session = registerProcess("pi", cwd, args.title, command);
  if (args.prompt) await sendPi(session, { type: "prompt", message: args.prompt });
  return session;
}

async function startOpenCode(args: { cwd: string; prompt: string; title?: string; model?: string; variant?: string; session?: string; continueRecent?: boolean }): Promise<Session> {
  const cwd = await requireCwd(args.cwd);
  const command = ["opencode", "run", "--format", "json", "--dir", cwd];
  if (args.model) command.push("--model", args.model);
  if (args.variant) command.push("--variant", args.variant);
  if (args.session) command.push("--session", args.session);
  else if (args.continueRecent) command.push("--continue");
  if (args.title) command.push("--title", args.title);
  command.push(args.prompt);
  const session = registerProcess("opencode", cwd, args.title, command);
  session.process.stdin.end();
  return session;
}

function processEnv(): NodeJS.ProcessEnv {
  const nodeBin = dirname(process.execPath);
  return { ...process.env, PATH: `${nodeBin}:${process.env.PATH ?? ""}`, NO_COLOR: "1", TERM: "dumb" };
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf-8", maxBuffer: 512 * 1024 }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

async function findPersistedPiSessions(limit: number): Promise<PersistedPiSession[]> {
  const sessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR ?? `${process.env.HOME ?? ""}/.pi/agent/sessions`;
  const output = await runCommand("find", [sessionRoot, "-type", "f", "-name", "*.jsonl", "-print"]);
  const candidates: Array<PersistedPiSession & { modifiedMs: number }> = [];
  for (const sessionFile of output.split("\n").filter(Boolean)) {
    const first = await fsReadFile(sessionFile, "utf-8").then((text) => text.split("\n", 1)[0]).catch(() => "");
    let header: { id?: string; sessionId?: string; cwd?: string; name?: string };
    try { header = JSON.parse(first) as typeof header; } catch { continue; }
    if (!header.cwd) continue;
    try { await requireAllowedPath(header.cwd, "persisted pi session cwd"); } catch { continue; }
    const modified = await runCommand("stat", ["-f", "%m", sessionFile]);
    const modifiedMs = (Number.parseInt(modified.trim(), 10) || 0) * 1000;
    const sessionId = header.id ?? header.sessionId ?? sessionFile.split("_").pop()?.replace(/\.jsonl$/, "") ?? sessionFile;
    candidates.push({ source: "disk", sessionId, sessionFile, cwd: header.cwd, name: header.name ?? null, modifiedAt: new Date(modifiedMs).toISOString(), modifiedMs });
  }
  return candidates.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, limit).map(({ modifiedMs: _unused, ...session }) => session);
}

async function validatePiControlArgs(command: PiControlCommand, args: Record<string, unknown>, session: Session): Promise<Record<string, unknown>> {
  if ("type" in args || "id" in args) throw new Error("agent_pi_command args must not contain reserved fields: type, id");
  if (command === "switch_session") {
    if (typeof args.sessionPath !== "string" || !args.sessionPath) throw new Error("switch_session requires args.sessionPath");
    return { ...args, sessionPath: await validateSessionReference(args.sessionPath, session.cwd) };
  }
  if (command === "export_html" && args.outputPath !== undefined) {
    if (typeof args.outputPath !== "string" || !args.outputPath) throw new Error("export_html args.outputPath must be a string");
    return { ...args, outputPath: await requireAllowedPath(args.outputPath, "export output path") };
  }
  return args;
}

function json(value: unknown): string { return JSON.stringify(value, null, 2); }
function jsonTool<S extends z.ZodTypeAny>(name: string, description: string, schema: Record<string, unknown>, validator: S, handler: ToolHandler<z.infer<S>>): RegisteredTool<S> {
  return { name, description, inputSchemaJson: schema, validator, handler: handler as ToolHandler };
}

export function buildAgentSessionTools(): RegisteredTool[] {
  if (!hasConfiguredPathRoots) return [];
  return [
    jsonTool("agent_start", `Start a local coding-agent session inside configured paths. Maximum ${MAX_SESSIONS} concurrent sessions; maximum runtime ${SESSION_MAX_RUNTIME_MS}ms. Pi remains steerable through RPC; OpenCode is a captured bounded job.`, {
      type: "object", properties: { agent: { type: "string", enum: ["pi", "opencode"] }, cwd: { type: "string" }, prompt: { type: "string" }, title: { type: "string" }, model: { type: "string" }, thinking: { type: "string" }, variant: { type: "string" }, continueRecent: { type: "boolean" }, session: { type: "string" } }, required: ["agent", "cwd"],
    }, z.object({ agent: z.enum(["pi", "opencode"]), cwd: z.string().min(1), prompt: z.string().optional(), title: z.string().optional(), model: z.string().optional(), thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(), variant: z.string().optional(), continueRecent: z.boolean().optional(), session: z.string().optional() }).refine((a) => a.agent === "pi" || !!a.prompt, { message: "opencode requires prompt" }), async (args) => {
      const session = args.agent === "pi" ? await startPi(args) : await startOpenCode({ ...args, prompt: args.prompt! });
      return json({ session: publicSession(session), note: args.agent === "pi" ? "Use agent_prompt/agent_steer/agent_status to drive this live pi session." : "OpenCode is running as a captured bounded job; poll with agent_status/agent_logs." });
    }),
    jsonTool("agent_list", "List active/recent coding-agent sessions; optionally include saved pi sessions whose project cwd is within MACHINECTL_ALLOWED_PATHS.", { type: "object", properties: { includePersistedPi: { type: "boolean" }, limit: { type: "number" } } }, z.object({ includePersistedPi: z.boolean().optional().default(false), limit: z.number().int().min(1).max(50).optional().default(20) }), async ({ includePersistedPi, limit }) => {
      trimFinishedSessions();
      return json({ sessions: [...sessions.values()].map(publicSession).slice(-limit), ...(includePersistedPi ? { persistedPi: await findPersistedPiSessions(limit) } : {}), limits: { maxConcurrentSessions: MAX_SESSIONS, maxRuntimeMs: SESSION_MAX_RUNTIME_MS } });
    }),
    jsonTool("agent_status", "Get status and recent structured events for a local coding-agent session.", { type: "object", properties: { id: { type: "string" }, eventLimit: { type: "number" } }, required: ["id"] }, z.object({ id: z.string(), eventLimit: z.number().int().min(0).max(100).optional().default(20) }), async ({ id, eventLimit }) => json({ session: publicSession(mustGetSession(id)), recentEvents: mustGetSession(id).events.slice(-eventLimit) })),
    jsonTool("agent_logs", "Read captured stdout/stderr from a local coding-agent session.", { type: "object", properties: { id: { type: "string" }, tailChars: { type: "number" } }, required: ["id"] }, z.object({ id: z.string(), tailChars: z.number().int().min(1).max(OUTPUT_CAP).optional().default(20000) }), async ({ id, tailChars }) => mustGetSession(id).output.slice(-tailChars) || "(no output yet)"),
    jsonTool("agent_prompt", "Send a prompt to a live pi RPC session. Use streamingBehavior=steer/followUp if pi is currently running.", { type: "object", properties: { id: { type: "string" }, message: { type: "string" }, streamingBehavior: { type: "string", enum: ["steer", "followUp"] } }, required: ["id", "message"] }, z.object({ id: z.string(), message: z.string().min(1), streamingBehavior: z.enum(["steer", "followUp"]).optional() }), async ({ id, message, streamingBehavior }) => json(await sendPi(mustGetSession(id), { type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) }))),
    jsonTool("agent_steer", "Queue steering guidance to a live pi RPC session while it is working.", { type: "object", properties: { id: { type: "string" }, message: { type: "string" } }, required: ["id", "message"] }, z.object({ id: z.string(), message: z.string().min(1) }), async ({ id, message }) => json(await sendPi(mustGetSession(id), { type: "steer", message }))),
    jsonTool("agent_follow_up", "Queue follow-up work for a live pi RPC session.", { type: "object", properties: { id: { type: "string" }, message: { type: "string" } }, required: ["id", "message"] }, z.object({ id: z.string(), message: z.string().min(1) }), async ({ id, message }) => json(await sendPi(mustGetSession(id), { type: "follow_up", message }))),
    jsonTool("agent_pi_command", "Issue an allow-listed pi RPC control command. Session paths and export output paths remain restricted to configured roots.", { type: "object", properties: { id: { type: "string" }, command: { type: "string" }, args: { type: "object" } }, required: ["id", "command"] }, z.object({ id: z.string(), command: z.enum(PI_CONTROL_COMMANDS), args: z.record(z.unknown()).optional().default({}) }), async ({ id, command, args }) => {
      const session = mustGetSession(id);
      const safeArgs = await validatePiControlArgs(command, args, session);
      return json(await sendPi(session, { ...safeArgs, type: command }, command === "compact" ? 120_000 : 10_000));
    }),
    jsonTool("agent_abort", "Abort current pi work or terminate an OpenCode job without removing its logs.", { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, z.object({ id: z.string() }), async ({ id }) => {
      const session = mustGetSession(id);
      if (session.agent === "pi" && !isTerminalStatus(session.status)) await sendPi(session, { type: "abort" }).catch(() => undefined);
      else stopSession(session, "stopped", "Agent job aborted by remote caller.");
      return json({ session: publicSession(session) });
    }),
    jsonTool("agent_stop", "Stop a local coding-agent process tree and retain captured logs for later inspection.", { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, z.object({ id: z.string() }), async ({ id }) => {
      const session = mustGetSession(id);
      stopSession(session, "stopped", "Agent session stopped by remote caller.");
      return json({ session: publicSession(session) });
    }),
  ];
}
