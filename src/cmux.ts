// cmux.ts — opt-in, bounded control of local cmux workspaces.
//
// This adapter uses cmux's public CLI over its local Unix socket. It never
// exposes that socket or accepts arbitrary cmux commands. Mutating Pi actions
// require a live cmux surface that is paired with a Pi session by cmux's own
// extension and whose recorded process is still a Pi process.

import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { childEnv } from "./child-env.js";
import type { RegisteredTool, ToolHandler } from "./protocol.js";

const execFileAsync = promisify(execFile);
const ENABLED = process.env.MACHINECTL_ENABLE_CMUX === "1" || process.env.MACHINECTL_ENABLE_CMUX === "true";
const CMUX_BIN = process.env.MACHINECTL_CMUX_BIN || "cmux";
// Injectable like CMUX_BIN so the liveness probe is testable; defaults to /bin/ps.
const PS_BIN = process.env.MACHINECTL_CMUX_PS_BIN || "/bin/ps";
const SESSION_STORE = process.env.MACHINECTL_CMUX_PI_SESSION_STORE || join(homedir(), ".cmuxterm", "pi-hook-sessions.json");
const PASSWORD_FILE = process.env.MACHINECTL_CMUX_PASSWORD_FILE;
const OUTPUT_CAP = 256 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 20_000;
const uuid = z.string().uuid();

type CmuxSurface = {
  id: string;
  ref?: string;
  title?: string;
  type?: string;
  selected?: boolean;
  active?: boolean;
};
type CmuxWorkspace = {
  id: string;
  ref?: string;
  title?: string;
  description?: string | null;
  selected?: boolean;
  active?: boolean;
  panes?: Array<{ surfaces?: CmuxSurface[] }>;
};
type CmuxTree = { windows?: Array<{ id?: string; ref?: string; workspaces?: CmuxWorkspace[] }> };
type PiSession = {
  sessionId: string;
  workspaceId: string;
  surfaceId: string;
  cwd?: string;
  pid?: number;
  runtimeStatus?: string;
  agentLifecycle?: string;
  lastBody?: string;
  updatedAt?: number;
};
type PiStore = { sessions?: Record<string, PiSession> };

function json(value: unknown): string { return JSON.stringify(value, null, 2); }
function tool<S extends z.ZodTypeAny>(name: string, description: string, schema: Record<string, unknown>, validator: S, handler: ToolHandler<z.infer<S>>): RegisteredTool<S> {
  return { name, description, inputSchemaJson: schema, validator, handler: handler as ToolHandler };
}

async function cmux(args: string[]): Promise<string> {
  const password = PASSWORD_FILE ? (await readFile(PASSWORD_FILE, "utf8")).trim() : undefined;
  if (PASSWORD_FILE && !password) throw new Error("cmux password file is empty");
  const { stdout, stderr } = await execFileAsync(CMUX_BIN, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: OUTPUT_CAP,
    env: childEnv("MACHINECTL_CMUX_ENV_PASSTHROUGH", { CMUX_QUIET: "1", ...(password ? { CMUX_SOCKET_PASSWORD: password } : {}) }),
  });
  if (stderr.trim()) throw new Error(`cmux failed: ${stderr.trim().slice(0, 500)}`);
  return stdout;
}

async function cmuxJson<T>(args: string[]): Promise<T> {
  const output = await cmux(["--json", "--id-format", "both", ...args]);
  try { return JSON.parse(output) as T; } catch { throw new Error("cmux returned invalid JSON"); }
}

async function tree(): Promise<CmuxTree> { return cmuxJson<CmuxTree>(["tree", "--all"]); }

async function piStore(): Promise<PiStore> {
  const raw = await readFile(SESSION_STORE, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  try { return JSON.parse(raw) as PiStore; } catch { throw new Error("cmux Pi session store contains invalid JSON"); }
}

function allWorkspaces(value: CmuxTree): CmuxWorkspace[] {
  return (value.windows ?? []).flatMap((window) => window.workspaces ?? []);
}
function allSurfaces(workspace: CmuxWorkspace): CmuxSurface[] {
  return (workspace.panes ?? []).flatMap((pane) => pane.surfaces ?? []);
}
function sessionsByWorkspace(store: PiStore): Map<string, PiSession[]> {
  const output = new Map<string, PiSession[]>();
  for (const session of Object.values(store.sessions ?? {})) {
    if (!session?.workspaceId || !session.surfaceId || !session.sessionId) continue;
    const current = output.get(session.workspaceId) ?? [];
    current.push(session);
    output.set(session.workspaceId, current);
  }
  return output;
}

async function snapshot() {
  const [layout, store] = await Promise.all([tree(), piStore()]);
  const paired = sessionsByWorkspace(store);
  return allWorkspaces(layout).map((workspace) => {
    const surfaces = allSurfaces(workspace);
    const liveSurfaceIds = new Set(surfaces.map((surface) => surface.id));
    const sessions = (paired.get(workspace.id) ?? []).filter((session) => liveSurfaceIds.has(session.surfaceId));
    return {
      id: workspace.id,
      ref: workspace.ref ?? null,
      title: workspace.title ?? "Untitled",
      description: workspace.description ?? null,
      selected: Boolean(workspace.selected || workspace.active),
      surfaces: surfaces.map((surface) => ({ id: surface.id, ref: surface.ref ?? null, title: surface.title ?? null, type: surface.type ?? "unknown", selected: Boolean(surface.selected || surface.active) })),
      piSessions: sessions.map((session) => publicPiSession(session, Boolean(session.pid && processIsPi(session.pid)))),
    };
  });
}

function publicPiSession(session: PiSession, livePid: boolean) {
  const lifecycle = session.agentLifecycle ?? "unknown";
  const dispatchable = livePid && lifecycle !== "unknown";
  const reason = !livePid
    ? "process-not-live"
    : lifecycle === "unknown"
      ? "lifecycle-unknown"
      : null;
  return {
    sessionId: session.sessionId,
    surfaceId: session.surfaceId,
    cwd: session.cwd ?? null,
    lifecycle,
    runtimeStatus: session.runtimeStatus ?? "unknown",
    lastAssistantText: session.lastBody?.slice(-4_000) ?? null,
    updatedAt: session.updatedAt ? new Date(session.updatedAt * 1_000).toISOString() : null,
    dispatchable,
    reason,
    generation: session.updatedAt ?? 0,
  };
}

async function requirePairedPi(workspaceId: string, surfaceId?: string, sessionId?: string): Promise<{ workspace: CmuxWorkspace; surface: CmuxSurface; session: PiSession }> {
  const [layout, store] = await Promise.all([tree(), piStore()]);
  const workspace = allWorkspaces(layout).find((candidate) => candidate.id.toLowerCase() === workspaceId.toLowerCase());
  if (!workspace) throw new Error("Unknown or stale cmux workspace ID. List workspaces again.");
  const surfaces = allSurfaces(workspace);
  // Rows for this workspace whose surface is still present in the live layout,
  // narrowed by the optional surfaceId / sessionId selectors. The store keeps
  // one row per Pi session, so a surface that has hosted several Pi processes
  // over time carries several rows that all share the same surfaceId.
  const matches = Object.values(store.sessions ?? {})
    .filter((session) => session.workspaceId?.toLowerCase() === workspace.id.toLowerCase())
    .filter((session) => surfaces.some((surface) => surface.id.toLowerCase() === session.surfaceId?.toLowerCase()))
    .filter((session) => !surfaceId || session.surfaceId?.toLowerCase() === surfaceId.toLowerCase())
    .filter((session) => !sessionId || session.sessionId?.toLowerCase() === sessionId.toLowerCase());
  if (matches.length === 0) throw new Error("No live Pi-paired surface matches this workspace.");
  const session = selectCurrentSession(matches, { sessionId, surfaceId });
  const surface = surfaces.find((candidate) => candidate.id.toLowerCase() === session.surfaceId.toLowerCase())!;
  if (surface.type !== "terminal") throw new Error("The paired Pi surface is not a terminal.");
  if (!session.pid || !processIsPi(session.pid)) throw new Error("The recorded Pi process is no longer live. Refresh or resume it locally first.");
  return { workspace, surface, session };
}

// Resolve a set of matching store rows to the single CURRENT Pi session,
// deterministically, and never silently choose a stale (dead-process) row.
//
// The store accumulates one row per Pi session, so a long-lived terminal surface
// ends up with many historical rows sharing its surfaceId. Filtering by surfaceId
// alone therefore still yields several candidates; the discriminator is process
// liveness: exactly one row's recorded pid is still a live Pi, the rest are dead.
function selectCurrentSession(matches: PiSession[], opts: { sessionId?: string; surfaceId?: string }): PiSession {
  if (matches.length === 1) return matches[0];
  // An explicit sessionId must identify one row on its own; do not fall through
  // to liveness heuristics that could pick a different session than asked for.
  if (opts.sessionId) throw new Error("Multiple Pi session rows share that sessionId; refresh the workspace list.");
  // Drop stale rows: a dead pid fails process.kill(pid, 0) cheaply (no ps spawn),
  // and a live-but-non-Pi pid fails the command check. What remains is current.
  const live = matches.filter((session) => session.pid !== undefined && processIsPi(session.pid));
  if (live.length === 0) throw new Error("The recorded Pi process is no longer live. Refresh or resume it locally first.");
  if (live.length === 1) return live[0];
  // More than one genuinely-live Pi remains. If they span different surfaces, the
  // caller must narrow by surfaceId. If they share one surface, take the freshest
  // by updatedAt, and refuse to guess on a tie rather than target a stale row.
  const surfacesInvolved = new Set(live.map((session) => session.surfaceId?.toLowerCase()));
  if (!opts.surfaceId && surfacesInvolved.size > 1) throw new Error("Multiple live Pi sessions match; provide surfaceId.");
  const sorted = [...live].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if ((sorted[0].updatedAt ?? 0) === (sorted[1].updatedAt ?? 0)) throw new Error("Multiple live Pi sessions match; provide sessionId to disambiguate.");
  return sorted[0];
}

function processIsPi(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "darwin" && process.platform !== "linux") return true;
    // ps is invoked with fixed argv; no caller-controlled value reaches a shell.
    return requireProcessCommand(pid);
  } catch { return false; }
}

function requireProcessCommand(pid: number): boolean {
  // Synchronous probing closes the race between validation and input as much as
  // practical; cmux still re-validates the surface handle on every command.
  const command = execFileSync(PS_BIN, ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 });
  return /(^|\/)pi(?:\s|$)/.test(command.trim()) || /pi-coding-agent/.test(command);
}

async function sendToPi(workspaceId: string, surfaceId: string | undefined, message: string, mode: "prompt" | "steer", sessionId?: string) {
  const { workspace, surface, session } = await requirePairedPi(workspaceId, surfaceId, sessionId);
  const lifecycle = session.agentLifecycle ?? "unknown";
  if (mode === "prompt" && lifecycle !== "idle") throw new Error(`Pi must be idle before prompting; current lifecycle is ${lifecycle}.`);
  if (mode === "steer" && lifecycle !== "running") throw new Error(`Pi must be running before steering; current lifecycle is ${lifecycle}.`);
  // Send text and Enter as separate exact-argv operations. cmux interprets
  // backslash escapes in send, so reject carriage returns and newlines rather
  // than allowing a message to synthesize extra terminal submissions.
  if (/[\r\n]/.test(message) || /\\[nr]/.test(message)) throw new Error("Remote Pi messages must be single-line and cannot contain cmux newline escapes.");
  const target = surface.ref ?? surface.id;
  const workspaceTarget = workspace.ref ?? workspace.id;
  await cmux(["send", "--workspace", workspaceTarget, "--surface", target, "--", message]);
  await cmux(["send-key", "--workspace", workspaceTarget, "--surface", target, "enter"]);
  return { ok: true, workspaceId, surfaceId: surface.id, sessionId: session.sessionId, mode };
}

const targetSchema = { type: "object", properties: { workspaceId: { type: "string", format: "uuid" }, surfaceId: { type: "string", format: "uuid" }, sessionId: { type: "string", format: "uuid" } }, required: ["workspaceId"] };
const targetValidator = z.object({ workspaceId: uuid, surfaceId: uuid.optional(), sessionId: uuid.optional() }).strict();

export function buildCmuxTools(): RegisteredTool[] {
  if (!ENABLED) return [];
  return [
    tool("cmux_workspace_list", "List local cmux workspaces, bounded surface metadata, and Pi session lifecycle. Returns opaque IDs that must be refreshed after layout changes.", { type: "object", properties: {} }, z.object({}).strict(), async () => json({ workspaces: await snapshot() })),
    tool("cmux_workspace_status", "Inspect one local cmux workspace and its paired Pi session status.", targetSchema, targetValidator, async ({ workspaceId }) => {
      const workspace = (await snapshot()).find((candidate) => candidate.id.toLowerCase() === workspaceId.toLowerCase());
      if (!workspace) throw new Error("Unknown or stale cmux workspace ID. List workspaces again.");
      return json({ workspace });
    }),
    tool("cmux_surface_tail", "Read a bounded terminal tail from a verified Pi-paired cmux surface. Resolves to the current live Pi session for the surface; pass surfaceId and/or sessionId to disambiguate. Terminal output may contain sensitive content.", { ...targetSchema, properties: { ...targetSchema.properties, lines: { type: "number", minimum: 1, maximum: 200 } } }, targetValidator.extend({ lines: z.number().int().min(1).max(200).optional().default(80) }), async ({ workspaceId, surfaceId, sessionId, lines }) => {
      const { workspace, surface, session } = await requirePairedPi(workspaceId, surfaceId, sessionId);
      const content = await cmux(["read-screen", "--workspace", workspace.ref ?? workspace.id, "--surface", surface.ref ?? surface.id, "--lines", String(lines)]);
      return json({ workspaceId, surfaceId: surface.id, sessionId: session.sessionId, content: content.slice(-OUTPUT_CAP) });
    }),
    tool("cmux_pi_prompt", "Submit one single-line prompt to an idle, live Pi process paired with a cmux workspace. Resolves to the current live Pi session for the surface; pass surfaceId and/or sessionId to disambiguate. Fails closed if identity or lifecycle cannot be verified.", { ...targetSchema, properties: { ...targetSchema.properties, message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH } }, required: ["workspaceId", "message"] }, targetValidator.extend({ message: z.string().min(1).max(MAX_MESSAGE_LENGTH) }), async ({ workspaceId, surfaceId, sessionId, message }) => json(await sendToPi(workspaceId, surfaceId, message, "prompt", sessionId))),
    tool("cmux_pi_steer", "Submit one single-line steering message to a running, live Pi process paired with a cmux workspace. Resolves to the current live Pi session for the surface; pass surfaceId and/or sessionId to disambiguate.", { ...targetSchema, properties: { ...targetSchema.properties, message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_LENGTH } }, required: ["workspaceId", "message"] }, targetValidator.extend({ message: z.string().min(1).max(MAX_MESSAGE_LENGTH) }), async ({ workspaceId, surfaceId, sessionId, message }) => json(await sendToPi(workspaceId, surfaceId, message, "steer", sessionId))),
    tool("cmux_pi_abort", "Send Ctrl-C to a running, verified Pi process paired with a cmux workspace.", targetSchema, targetValidator, async ({ workspaceId, surfaceId, sessionId }) => {
      const { workspace, surface, session } = await requirePairedPi(workspaceId, surfaceId, sessionId);
      if (session.agentLifecycle !== "running") throw new Error(`Pi must be running before aborting; current lifecycle is ${session.agentLifecycle ?? "unknown"}.`);
      await cmux(["send-key", "--workspace", workspace.ref ?? workspace.id, "--surface", surface.ref ?? surface.id, "ctrl-c"]);
      return json({ ok: true, workspaceId, surfaceId: surface.id, sessionId: session.sessionId });
    }),
    tool("cmux_workspace_focus", "Focus an existing local cmux workspace by fresh workspace ID.", { type: "object", properties: { workspaceId: { type: "string", format: "uuid" } }, required: ["workspaceId"] }, z.object({ workspaceId: uuid }).strict(), async ({ workspaceId }) => {
      const workspace = (await snapshot()).find((candidate) => candidate.id.toLowerCase() === workspaceId.toLowerCase());
      if (!workspace) throw new Error("Unknown or stale cmux workspace ID. List workspaces again.");
      await cmux(["select-workspace", "--workspace", workspace.id]);
      return json({ ok: true, workspaceId: workspace.id });
    }),
  ];
}
