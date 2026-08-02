import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath as fsRealpath } from "node:fs/promises";
import { dirname, resolve as pathResolve } from "node:path";
import type { HarnessAdapter, Session, Status } from "./types.js";

export const OUTPUT_CAP = 512 * 1024;
const FINISHED_RETENTION_MS = 24 * 60 * 60 * 1000;

export function boundedInt(envName: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[envName] ?? "", 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

export const MAX_SESSIONS = boundedInt("MACHINECTL_PI_MAX_SESSIONS", 4, 1, 32);
export const SESSION_MAX_RUNTIME_MS = boundedInt("MACHINECTL_PI_MAX_RUNTIME_MS", 2 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000);
const STOP_GRACE_MS = boundedInt("MACHINECTL_PI_STOP_GRACE_MS", 5_000, 100, 60_000);

const sessions = new Map<string, Session>();

const configuredRoots = (process.env.MACHINECTL_ALLOWED_PATHS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((root) => pathResolve(root));
export const hasConfiguredPathRoots = configuredRoots.length > 0;
let cachedCanonicalRoots: Promise<string[]> | undefined;

async function canonicalRoots(): Promise<string[]> {
  cachedCanonicalRoots ??= Promise.all(configuredRoots.map(async (root) => fsRealpath(root).catch(() => root)));
  return cachedCanonicalRoots;
}

export async function requireAllowedPath(path: string, label: string): Promise<string> {
  if (!hasConfiguredPathRoots) {
    throw new Error(`MACHINECTL_ALLOWED_PATHS is empty. ${label} needs a permitted path.`);
  }
  const resolved = pathResolve(path);
  const canonical = await fsRealpath(resolved).catch(() => resolved);
  const roots = await canonicalRoots();
  const allowed = roots.some((root) => canonical === root || canonical.startsWith(root + "/"));
  if (!allowed) throw new Error(`${label} "${path}" is not in MACHINECTL_ALLOWED_PATHS (${roots.join(", ")}).`);
  return canonical;
}

export async function requireCwd(path: string): Promise<string> {
  const canonical = await fsRealpath(pathResolve(path)).catch(() => {
    throw new Error(`The directory does not exist: ${path}`);
  });
  await requireAllowedPath(canonical, "cwd");
  await access(canonical);
  return canonical;
}

function capAppend(existing: string, addition: string): string {
  const combined = existing + addition;
  return combined.length <= OUTPUT_CAP ? combined : combined.slice(combined.length - OUTPUT_CAP);
}

export function isTerminalStatus(status: Status): boolean {
  return status === "stopped" || status === "exited" || status === "error" || status === "timed_out";
}

export function trimFinishedSessions() {
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
    throw new Error(`There are too many harness sessions (${MAX_SESSIONS}). Stop one session before you start a new session.`);
  }
}

export function allSessions(): Session[] {
  return [...sessions.values()];
}

export function mustGetSession(id: string): Session {
  trimFinishedSessions();
  const session = sessions.get(id);
  if (!session) throw new Error(`There is no harness session with the identifier ${id}.`);
  return session;
}

export function publicSession(session: Session) {
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

export function pushEvent(session: Session, event: unknown) {
  session.events.push(event);
  if (session.events.length > 500) session.events.splice(0, session.events.length - 500);
  session.updatedAt = Date.now();
}

export function setStatus(session: Session, status: Status) {
  if (isTerminalStatus(session.status)) return;
  session.status = status;
  session.updatedAt = Date.now();
}

export function resolveWaiter(session: Session, id: string, payload: unknown): boolean {
  const waiter = session.responseWaiters.get(id);
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  session.responseWaiters.delete(id);
  waiter.resolve(payload);
  return true;
}

export function rejectWaiter(session: Session, id: string, error: Error): boolean {
  const waiter = session.responseWaiters.get(id);
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  session.responseWaiters.delete(id);
  waiter.reject(error);
  return true;
}

function signalProcessTree(session: Session, signal: NodeJS.Signals) {
  const pid = session.process.pid;
  if (!pid || session.process.exitCode !== null) return;
  if (process.platform === "win32") {
    session.process.kill(signal);
    return;
  }
  try { process.kill(-pid, signal); } catch { try { session.process.kill(signal); } catch {} }
}

export function stopSession(session: Session, terminalStatus: "stopped" | "timed_out", reason?: string) {
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

export function writeFrame(session: Session, frame: unknown): void {
  session.process.stdin.write(JSON.stringify(frame) + "\n");
}

export function requestWithId(session: Session, correlationId: string, frame: unknown, waitMs = 10_000, label = "request"): Promise<unknown> {
  if (isTerminalStatus(session.status) || session.status === "stopping") {
    throw new Error(`The harness session ${session.id} has the status ${session.status}.`);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.responseWaiters.delete(correlationId);
      reject(new Error(`${session.harnessId} did not reply to ${label} before the time limit.`));
    }, waitMs);
    session.responseWaiters.set(correlationId, { resolve, reject, timer });
    session.process.stdin.write(JSON.stringify(frame) + "\n", (err) => {
      if (!err) return;
      clearTimeout(timer);
      session.responseWaiters.delete(correlationId);
      reject(err);
    });
  });
}

export function processEnv(): NodeJS.ProcessEnv {
  const nodeBin = dirname(process.execPath);
  return { ...process.env, PATH: `${nodeBin}:${process.env.PATH ?? ""}`, NO_COLOR: "1", TERM: "dumb" };
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
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { pushEvent(session, { type: "stdout", text: line }); continue; }
      if (session.adapter.onMessage) session.adapter.onMessage(session, parsed);
      else pushEvent(session, parsed);
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
      waiter.reject(new Error(`The ${session.harnessId} process stopped before it replied. Exit code: ${code ?? "unknown"}.`));
    }
    session.responseWaiters.clear();
  });
}

export function registerProcess(adapter: HarnessAdapter, cwd: string, title: string | undefined, command: string[]): Session {
  assertCapacity();
  const child: ChildProcessWithoutNullStreams = spawn(command[0], command.slice(1), {
    cwd,
    env: processEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const session = {} as Session;
  Object.assign(session, {
    id: randomUUID(), harnessId: adapter.id, adapter, cwd, title, command, process: child, status: "idle",
    startedAt: Date.now(), updatedAt: Date.now(), output: "", events: [], responseWaiters: new Map(), state: {},
    lifetimeTimer: setTimeout(
      () => stopSession(session, "timed_out", `The harness session operated for more than the limit of ${SESSION_MAX_RUNTIME_MS} ms.`),
      SESSION_MAX_RUNTIME_MS,
    ),
  });
  sessions.set(session.id, session);
  attachOutput(session);
  return session;
}
