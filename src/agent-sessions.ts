// agent-sessions.ts — opt-in local pi RPC session control.
//
// Pi runs through its structured JSONL RPC protocol and remains steerable.
// These tools publish only when MACHINECTL_ENABLE_PI=1 and allowed project
// roots are configured; they are an optional extension of the core laptop
// capability surface, not required for basic machine control.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir, readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { dirname, isAbsolute, resolve as pathResolve } from "node:path";
import { z } from "zod";
import type { RegisteredTool, ToolHandler } from "./protocol.js";

const OUTPUT_CAP = 512 * 1024;
const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = boundedInt("MACHINECTL_PI_MAX_SESSIONS", 4, 1, 32);
const SESSION_MAX_RUNTIME_MS = boundedInt("MACHINECTL_PI_MAX_RUNTIME_MS", 2 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
const STOP_GRACE_MS = boundedInt("MACHINECTL_PI_STOP_GRACE_MS", 5_000, 100, 60_000);
const PERSISTED_SESSION_CACHE_MS = boundedInt("MACHINECTL_PI_PERSISTED_CACHE_MS", 10_000, 1_000, 60_000);
const PERSISTED_SCAN_CONCURRENCY = 16;
const PI_CONTROL_COMMANDS = [
  "get_state", "get_messages", "get_session_stats", "get_last_assistant_text", "get_commands", "get_available_models",
  "set_model", "set_thinking_level", "compact", "set_auto_compaction", "set_auto_retry", "new_session", "switch_session",
  "fork", "clone", "get_fork_messages", "set_session_name", "export_html",
] as const;

type Status = "idle" | "running" | "stopping" | "stopped" | "exited" | "error" | "timed_out";
type PiControlCommand = typeof PI_CONTROL_COMMANDS[number];

type HarnessId = "pi";

type Session = {
  id: string;
  harnessId: HarnessId;
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
const PI_TOOLS_ENABLED = process.env.MACHINECTL_ENABLE_PI === "1" || process.env.MACHINECTL_ENABLE_PI === "true";
let cachedCanonicalRoots: Promise<string[]> | undefined;
let persistedSessionCache: { at: number; sessions: PersistedPiSession[] } | undefined;

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
    throw new Error(`Maximum concurrent pi sessions reached (${MAX_SESSIONS}). Stop an existing session before starting another.`);
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
  if (!session) throw new Error(`Unknown harness session: ${id}`);
  return session;
}

function publicSession(session: Session) {
  return {
    id: session.id,
    harnessId: session.harnessId,
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
      waiter.reject(new Error(`Pi process exited before replying (code ${code ?? "?"})`));
    }
    session.responseWaiters.clear();
  });
}

function registerProcess(harnessId: HarnessId, cwd: string, title: string | undefined, command: string[]): Session {
  assertCapacity();
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: processEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const session = {} as Session;
  Object.assign(session, {
    id: randomUUID(), harnessId, cwd, title, command, process: child, status: "idle",
    startedAt: Date.now(), updatedAt: Date.now(), output: "", events: [], responseWaiters: new Map(),
    lifetimeTimer: setTimeout(() => stopSession(session, "timed_out", `Harness session exceeded maximum runtime of ${SESSION_MAX_RUNTIME_MS}ms.`), SESSION_MAX_RUNTIME_MS),
  });
  sessions.set(session.id, session);
  attachOutput(session);
  return session;
}

function sendPi(session: Session, command: Record<string, unknown>, waitMs = 10_000): Promise<unknown> {
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

function processEnv(): NodeJS.ProcessEnv {
  const nodeBin = dirname(process.execPath);
  return { ...process.env, PATH: `${nodeBin}:${process.env.PATH ?? ""}`, NO_COLOR: "1", TERM: "dumb" };
}

async function findSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}

async function mapBounded<T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R | undefined>): Promise<R[]> {
  const output: R[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const value = values[cursor++];
      const result = await worker(value);
      if (result !== undefined) output.push(result);
    }
  }));
  return output;
}

async function findPersistedPiSessions(limit: number): Promise<PersistedPiSession[]> {
  if (persistedSessionCache && Date.now() - persistedSessionCache.at < PERSISTED_SESSION_CACHE_MS) return persistedSessionCache.sessions.slice(0, limit);
  const startedAt = Date.now();
  const sessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR ?? `${process.env.HOME ?? ""}/.pi/agent/sessions`;
  const files = await findSessionFiles(sessionRoot);
  const candidates = await mapBounded(files, PERSISTED_SCAN_CONCURRENCY, async (sessionFile) => {
    const [first, info] = await Promise.all([
      fsReadFile(sessionFile, "utf-8").then((text) => text.split("\n", 1)[0]).catch(() => ""),
      fsStat(sessionFile).catch(() => undefined),
    ]);
    if (!info) return undefined;
    let header: { id?: string; sessionId?: string; cwd?: string; name?: string };
    try { header = JSON.parse(first) as typeof header; } catch { return undefined; }
    if (!header.cwd) return undefined;
    try { await requireAllowedPath(header.cwd, "persisted pi session cwd"); } catch { return undefined; }
    const modifiedMs = info.mtimeMs;
    const sessionId = header.id ?? header.sessionId ?? sessionFile.split("_").pop()?.replace(/\.jsonl$/, "") ?? sessionFile;
    return { source: "disk" as const, sessionId, sessionFile, cwd: header.cwd, name: header.name ?? null, modifiedAt: new Date(modifiedMs).toISOString(), modifiedMs };
  });
  const sessions = candidates.sort((a, b) => b.modifiedMs - a.modifiedMs).map(({ modifiedMs: _unused, ...session }) => session);
  persistedSessionCache = { at: Date.now(), sessions };
  if (process.env.MACHINECTL_LOG_TIMING === "1") console.log("[machinectl]", "timing", "pi_persisted_scan", JSON.stringify({ files: files.length, sessions: sessions.length, durationMs: Date.now() - startedAt }));
  return sessions.slice(0, limit);
}

async function validatePiControlArgs(command: PiControlCommand, args: Record<string, unknown>, session: Session): Promise<Record<string, unknown>> {
  if ("type" in args || "id" in args) throw new Error("pi_command args must not contain reserved fields: type, id");
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
  if (!PI_TOOLS_ENABLED || !hasConfiguredPathRoots) return [];
  const piTools: RegisteredTool[] = PI_TOOLS_ENABLED ? [
    jsonTool("pi_start", `Start a live local pi RPC session inside configured paths. Maximum ${MAX_SESSIONS} active sessions; maximum runtime ${SESSION_MAX_RUNTIME_MS}ms.`, {
      type: "object", properties: { cwd: { type: "string" }, title: { type: "string" }, model: { type: "string" }, thinking: { type: "string" }, continueRecent: { type: "boolean" }, session: { type: "string" } }, required: ["cwd"],
    }, z.object({ cwd: z.string().min(1), title: z.string().optional(), model: z.string().optional(), thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(), continueRecent: z.boolean().optional(), session: z.string().optional() }), async (args) => json({ session: publicSession(await startPi(args)) })),
    jsonTool("pi_list", "List active/recent pi sessions; optionally include persisted pi sessions whose project cwd is permitted.", { type: "object", properties: { includePersisted: { type: "boolean" }, limit: { type: "number" } } }, z.object({ includePersisted: z.boolean().optional().default(false), limit: z.number().int().min(1).max(50).optional().default(20) }), async ({ includePersisted, limit }) => {
      trimFinishedSessions();
      return json({ sessions: [...sessions.values()].map(publicSession).slice(-limit), ...(includePersisted ? { persisted: await findPersistedPiSessions(limit) } : {}), limits: { maxConcurrentSessions: MAX_SESSIONS, maxRuntimeMs: SESSION_MAX_RUNTIME_MS } });
    }),
    jsonTool("pi_status", "Get status and recent structured events for a local pi RPC session.", { type: "object", properties: { id: { type: "string" }, eventLimit: { type: "number" } }, required: ["id"] }, z.object({ id: z.string(), eventLimit: z.number().int().min(0).max(100).optional().default(20) }), async ({ id, eventLimit }) => { const session = mustGetSession(id); return json({ session: publicSession(session), recentEvents: session.events.slice(-eventLimit) }); }),
    jsonTool("pi_logs", "Read captured stdout/stderr from a local pi RPC session.", { type: "object", properties: { id: { type: "string" }, tailChars: { type: "number" } }, required: ["id"] }, z.object({ id: z.string(), tailChars: z.number().int().min(1).max(OUTPUT_CAP).optional().default(20000) }), async ({ id, tailChars }) => mustGetSession(id).output.slice(-tailChars) || "(no output yet)"),
    jsonTool("pi_prompt", "Send a prompt to a live pi RPC session. Use streamingBehavior=steer/followUp if pi is currently running.", { type: "object", properties: { id: { type: "string" }, message: { type: "string" }, streamingBehavior: { type: "string", enum: ["steer", "followUp"] } }, required: ["id", "message"] }, z.object({ id: z.string(), message: z.string().min(1), streamingBehavior: z.enum(["steer", "followUp"]).optional() }), async ({ id, message, streamingBehavior }) => json(await sendPi(mustGetSession(id), { type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) }))),
    jsonTool("pi_steer", "Queue steering guidance to a live pi RPC session while it is working.", { type: "object", properties: { id: { type: "string" }, message: { type: "string" } }, required: ["id", "message"] }, z.object({ id: z.string(), message: z.string().min(1) }), async ({ id, message }) => json(await sendPi(mustGetSession(id), { type: "steer", message }))),
    jsonTool("pi_follow_up", "Queue follow-up work for a live pi RPC session.", { type: "object", properties: { id: { type: "string" }, message: { type: "string" } }, required: ["id", "message"] }, z.object({ id: z.string(), message: z.string().min(1) }), async ({ id, message }) => json(await sendPi(mustGetSession(id), { type: "follow_up", message }))),
    jsonTool("pi_command", "Issue an allow-listed pi RPC control command. Session paths and export output paths remain restricted to configured roots.", { type: "object", properties: { id: { type: "string" }, command: { type: "string" }, args: { type: "object" } }, required: ["id", "command"] }, z.object({ id: z.string(), command: z.enum(PI_CONTROL_COMMANDS), args: z.record(z.unknown()).optional().default({}) }), async ({ id, command, args }) => {
      const session = mustGetSession(id);
      const safeArgs = await validatePiControlArgs(command, args, session);
      return json(await sendPi(session, { ...safeArgs, type: command }, command === "compact" ? 120_000 : 10_000));
    }),
    jsonTool("pi_abort", "Abort current work in a local pi RPC session.", { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, z.object({ id: z.string() }), async ({ id }) => json(await sendPi(mustGetSession(id), { type: "abort" }).catch(() => ({ aborted: false })))),
    jsonTool("pi_stop", "Stop a local pi RPC session and retain captured logs for inspection.", { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, z.object({ id: z.string() }), async ({ id }) => { const session = mustGetSession(id); stopSession(session, "stopped", "Pi session stopped by remote caller."); return json({ session: publicSession(session) }); }),
  ] : [];
  const adapters = [
    ...(PI_TOOLS_ENABLED ? [{ id: "pi", label: "Pi", capabilities: ["start", "list", "status", "logs", "prompt", "steer", "follow_up", "control", "abort", "stop", "persisted_sessions"] }] : []),
  ];
  const sessionValidator = z.object({ harnessId: z.enum(["pi"]).optional(), id: z.string() });
  const sessionSchema = { type: "object", properties: { harnessId: { type: "string", enum: adapters.map((adapter) => adapter.id) }, id: { type: "string" } }, required: ["id"] };
  const requireCapability = (id: string, capability: string) => { const session = mustGetSession(id); const adapter = adapters.find((item) => item.id === session.harnessId); if (!adapter?.capabilities.includes(capability)) throw new Error(`Harness ${session.harnessId} does not support ${capability}.`); return session; };
  return [
    jsonTool("harness_catalog", "List available local delegated-agent harnesses and their honest capabilities.", { type: "object", properties: {} }, z.object({}).strict(), async () => json({ harnesses: adapters })),
    jsonTool("harness_start", "Start a local delegated-agent harness session.", { type: "object", properties: { harnessId: { type: "string", enum: adapters.map((adapter) => adapter.id) }, cwd: { type: "string" }, prompt: { type: "string" }, title: { type: "string" }, model: { type: "string" }, thinking: { type: "string" }, continueRecent: { type: "boolean" }, session: { type: "string" } }, required: ["harnessId", "cwd"] }, z.object({ harnessId: z.enum(["pi"]), cwd: z.string().min(1), prompt: z.string().optional(), title: z.string().optional(), model: z.string().optional(), thinking: z.string().optional(), continueRecent: z.boolean().optional(), session: z.string().optional() }), async ({ harnessId, ...args }) => { if (!adapters.some((adapter) => adapter.id === harnessId)) throw new Error(`Harness ${harnessId} is not enabled.`); return json({ session: publicSession(await startPi(args)) }); }),
    jsonTool("harness_list", "List active/recent local delegated-agent harness sessions.", { type: "object", properties: { harnessId: { type: "string", enum: adapters.map((adapter) => adapter.id) }, limit: { type: "number" } } }, z.object({ harnessId: z.enum(["pi"]).optional(), limit: z.number().int().min(1).max(50).optional().default(20) }), async ({ harnessId, limit }) => { trimFinishedSessions(); return json({ sessions: [...sessions.values()].filter((session) => !harnessId || session.harnessId === harnessId).map(publicSession).slice(-limit) }); }),
    jsonTool("harness_status", "Get normalized status and recent events for a local delegated-agent harness session.", { ...sessionSchema, properties: { ...sessionSchema.properties, eventLimit: { type: "number" } } }, sessionValidator.extend({ eventLimit: z.number().int().min(0).max(100).optional().default(20) }), async ({ id, eventLimit }) => { const session = mustGetSession(id); return json({ session: publicSession(session), recentEvents: session.events.slice(-eventLimit) }); }),
    jsonTool("harness_logs", "Read bounded logs from a local delegated-agent harness session.", { ...sessionSchema, properties: { ...sessionSchema.properties, tailChars: { type: "number" } } }, sessionValidator.extend({ tailChars: z.number().int().min(1).max(OUTPUT_CAP).optional().default(20000) }), async ({ id, tailChars }) => mustGetSession(id).output.slice(-tailChars) || "(no output yet)"),
    jsonTool("harness_prompt", "Send a prompt when the selected harness supports it.", { ...sessionSchema, properties: { ...sessionSchema.properties, message: { type: "string" } }, required: ["id", "message"] }, sessionValidator.extend({ message: z.string().min(1) }), async ({ id, message }) => json(await sendPi(requireCapability(id, "prompt"), { type: "prompt", message }))),
    jsonTool("harness_steer", "Queue steering guidance when the selected harness supports it.", { ...sessionSchema, properties: { ...sessionSchema.properties, message: { type: "string" } }, required: ["id", "message"] }, sessionValidator.extend({ message: z.string().min(1) }), async ({ id, message }) => json(await sendPi(requireCapability(id, "steer"), { type: "steer", message }))),
    jsonTool("harness_follow_up", "Queue follow-up work when the selected harness supports it.", { ...sessionSchema, properties: { ...sessionSchema.properties, message: { type: "string" } }, required: ["id", "message"] }, sessionValidator.extend({ message: z.string().min(1) }), async ({ id, message }) => json(await sendPi(requireCapability(id, "follow_up"), { type: "follow_up", message }))),
    jsonTool("harness_control", "Issue an allow-listed adapter-specific control command when supported.", { ...sessionSchema, properties: { ...sessionSchema.properties, command: { type: "string" }, args: { type: "object" } }, required: ["id", "command"] }, sessionValidator.extend({ command: z.enum(PI_CONTROL_COMMANDS), args: z.record(z.unknown()).optional().default({}) }), async ({ id, command, args }) => { const session = requireCapability(id, "control"); return json(await sendPi(session, { ...await validatePiControlArgs(command, args, session), type: command }, command === "compact" ? 120_000 : 10_000)); }),
    jsonTool("harness_abort", "Abort current work when the selected harness supports it.", sessionSchema, sessionValidator, async ({ id }) => json(await sendPi(requireCapability(id, "abort"), { type: "abort" }).catch(() => ({ aborted: false })))),
    jsonTool("harness_stop", "Stop a local delegated-agent harness session and retain bounded logs.", sessionSchema, sessionValidator, async ({ id }) => { const session = requireCapability(id, "stop"); stopSession(session, "stopped", "Harness session stopped by remote caller."); return json({ session: publicSession(session) }); }),
    ...piTools,
  ];
}
