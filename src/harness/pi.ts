import { randomUUID } from "node:crypto";
import { readdir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  boundedInt, isTerminalStatus, mustGetSession, pushEvent, registerProcess, requestWithId,
  requireAllowedPath, requireCwd, resolveWaiter, setStatus,
} from "./runtime.js";
import type { HarnessAdapter, HarnessCapability, Session, StartArgs } from "./types.js";

const PERSISTED_SESSION_CACHE_MS = boundedInt("MACHINECTL_PI_PERSISTED_CACHE_MS", 10_000, 1_000, 60_000);
const PERSISTED_SCAN_CONCURRENCY = 16;

export const PI_CONTROL_COMMANDS = [
  "get_state", "get_messages", "get_session_stats", "get_last_assistant_text", "get_commands", "get_available_models",
  "set_model", "set_thinking_level", "compact", "set_auto_compaction", "set_auto_retry", "new_session", "switch_session",
  "fork", "clone", "get_fork_messages", "set_session_name", "export_html",
] as const;
export type PiControlCommand = typeof PI_CONTROL_COMMANDS[number];

export type PersistedPiSession = {
  source: "disk";
  sessionId: string;
  sessionFile: string;
  cwd: string;
  name: string | null;
  modifiedAt: string;
};

let persistedSessionCache: { at: number; sessions: PersistedPiSession[] } | undefined;

function send(session: Session, command: Record<string, unknown>, waitMs = 10_000): Promise<unknown> {
  if (isTerminalStatus(session.status) || session.status === "stopping") {
    throw new Error(`The pi session ${session.id} has the status ${session.status}.`);
  }
  const id = randomUUID();
  return requestWithId(session, id, { ...command, id }, waitMs, String(command.type));
}

export function sendPi(session: Session, command: Record<string, unknown>, waitMs = 10_000): Promise<unknown> {
  return send(session, command, waitMs);
}

function isBareSessionIdThatPiResolvesItself(reference: string): boolean {
  return !isAbsolute(reference) && !reference.includes("/");
}

export async function validateSessionReference(reference: string, cwd: string): Promise<string> {
  if (isBareSessionIdThatPiResolvesItself(reference)) return reference;
  const sessionPath = await requireAllowedPath(reference, "pi session path");
  const first = await fsReadFile(sessionPath, "utf-8").then((content) => content.split("\n", 1)[0]).catch(() => "");
  try {
    const header = JSON.parse(first) as { cwd?: string };
    if (header.cwd) await requireAllowedPath(header.cwd, "pi session cwd");
  } catch {}
  await requireAllowedPath(cwd, "cwd");
  return sessionPath;
}

export async function validatePiControlArgs(command: string, args: Record<string, unknown>, session: Session): Promise<Record<string, unknown>> {
  if ("type" in args || "id" in args) throw new Error("The pi control arguments must not contain the reserved fields type and id.");
  if (command === "switch_session") {
    if (typeof args.sessionPath !== "string" || !args.sessionPath) throw new Error("The switch_session command needs args.sessionPath.");
    return { ...args, sessionPath: await validateSessionReference(args.sessionPath, session.cwd) };
  }
  if (command === "export_html" && args.outputPath !== undefined) {
    if (typeof args.outputPath !== "string" || !args.outputPath) throw new Error("The export_html argument args.outputPath must be a string.");
    return { ...args, outputPath: await requireAllowedPath(args.outputPath, "export output path") };
  }
  return args;
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

export async function findPersistedPiSessions(limit: number): Promise<PersistedPiSession[]> {
  if (persistedSessionCache && Date.now() - persistedSessionCache.at < PERSISTED_SESSION_CACHE_MS) {
    return persistedSessionCache.sessions.slice(0, limit);
  }
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
    const sessionId = header.id ?? header.sessionId ?? sessionFile.split("_").pop()?.replace(/\.jsonl$/, "") ?? sessionFile;
    return { source: "disk" as const, sessionId, sessionFile, cwd: header.cwd, name: header.name ?? null, modifiedAt: new Date(info.mtimeMs).toISOString(), modifiedMs: info.mtimeMs };
  });
  const scanned = candidates.sort((a, b) => b.modifiedMs - a.modifiedMs).map(({ modifiedMs: _unused, ...session }) => session);
  persistedSessionCache = { at: Date.now(), sessions: scanned };
  if (process.env.MACHINECTL_LOG_TIMING === "1") {
    console.log("[machinectl]", "timing", "pi_persisted_scan", JSON.stringify({ files: files.length, sessions: scanned.length, durationMs: Date.now() - startedAt }));
  }
  return scanned.slice(0, limit);
}

const PI_CAPABILITIES: HarnessCapability[] = [
  "start", "list", "status", "logs", "prompt", "steer", "follow_up", "control", "abort", "stop", "persisted_sessions",
];

export const piAdapter: HarnessAdapter = {
  id: "pi",
  label: "Pi",
  capabilities: PI_CAPABILITIES,
  controlCommands: PI_CONTROL_COMMANDS,
  note: "The Pi JSONL RPC protocol (pi --mode rpc). It has all control operations. It can also find sessions that Pi kept on disk.",

  async start(args: StartArgs): Promise<Session> {
    const cwd = await requireCwd(args.cwd);
    const command = ["pi", "--mode", "rpc"];
    if (args.model) command.push("--model", args.model);
    if (args.thinking) command.push("--thinking", args.thinking);
    if (args.session) command.push("--session", await validateSessionReference(args.session, cwd));
    else if (args.continueRecent) command.push("--continue");
    const session = registerProcess(piAdapter, cwd, args.title, command);
    if (args.prompt) await send(session, { type: "prompt", message: args.prompt });
    return session;
  },

  onMessage(session, message) {
    pushEvent(session, message);
    if (typeof message !== "object" || message === null) return;
    const obj = message as Record<string, unknown>;
    if (obj.type === "agent_start") setStatus(session, "running");
    if (obj.type === "agent_end") setStatus(session, "idle");
    if (obj.type === "response" && typeof obj.id === "string") resolveWaiter(session, obj.id, message);
  },

  prompt: (session, message, streamingBehavior) =>
    send(session, { type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) }),
  steer: (session, message) => send(session, { type: "steer", message }),
  followUp: (session, message) => send(session, { type: "follow_up", message }),

  async control(session, command, args) {
    if (!PI_CONTROL_COMMANDS.includes(command as PiControlCommand)) {
      throw new Error(`pi does not have the control command "${command}".`);
    }
    const safeArgs = await validatePiControlArgs(command, args, session);
    return send(session, { ...safeArgs, type: command }, command === "compact" ? 120_000 : 10_000);
  },

  abort: (session) => send(session, { type: "abort" }).catch(() => ({ aborted: false })),
  listPersisted: (limit) => findPersistedPiSessions(limit),
};

export { mustGetSession };
