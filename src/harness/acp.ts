import { readFile, writeFile } from "node:fs/promises";
import {
  boundedInt, isTerminalStatus, pushEvent, registerProcess, requestWithId, requireAllowedPath,
  requireCwd, resolveWaiter, rejectWaiter, setStatus, writeFrame,
} from "./runtime.js";
import type { HarnessAdapter, HarnessCapability, Session, StartArgs } from "./types.js";

const HANDSHAKE_TIMEOUT_MS = boundedInt("MACHINECTL_ACP_HANDSHAKE_TIMEOUT_MS", 60_000, 5_000, 300_000);
const PROMPT_TIMEOUT_MS = boundedInt("MACHINECTL_ACP_PROMPT_TIMEOUT_MS", 300_000, 10_000, 60 * 60_000);
const ACP_PROTOCOL_VERSION = 1;

type PermissionPolicy = "deny" | "allow" | "ask";
const PERMISSION_POLICY: PermissionPolicy = (() => {
  const raw = (process.env.MACHINECTL_ACP_PERMISSION ?? "deny").toLowerCase();
  return raw === "allow" || raw === "ask" ? raw : "deny";
})();
const PERMISSION_TIMEOUT_MS = boundedInt("MACHINECTL_ACP_PERMISSION_TIMEOUT_MS", 120_000, 5_000, 30 * 60_000);

const MODE_PREFERENCE = [
  "read-only", "readonly", "plan", "ask", "default", "auto",
  "acceptEdits", "agent", "dontAsk", "agent-full-access", "bypassPermissions",
];

type AcpAgentConfig = { id: string; label: string; command: string[]; note: string };

const BUILT_IN_AGENTS: AcpAgentConfig[] = [
  { id: "opencode", label: "OpenCode", command: ["opencode", "acp"], note: "Native ACP. To install, use: npm i -g opencode-ai. This agent has no session modes. It writes files without a request for permission. machinectl cannot control it." },
  { id: "claude", label: "Claude Agent", command: ["claude-agent-acp"], note: "To install, use: npm i -g @agentclientprotocol/claude-agent-acp. This agent needs its own credentials in the environment. A `claude` CLI that has a login is not sufficient." },
  { id: "codex", label: "Codex", command: ["codex-acp"], note: "To install, use: npm i -g @agentclientprotocol/codex-acp. This agent has the modes read-only, agent, and agent-full-access. It obeys a refused permission." },
  { id: "amp", label: "Amp", command: ["amp-acp"], note: "To install, use: npm i -g amp-acp. This agent has no session modes. It cannot resume or list sessions." },
  { id: "gemini", label: "Gemini CLI", command: ["gemini", "--experimental-acp"], note: "To install, use: npm i -g @google/gemini-cli" },
];

function envCommandOverride(id: string): string[] | undefined {
  const raw = process.env[`MACHINECTL_ACP_COMMAND_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (!raw?.trim()) return undefined;
  const parts = raw.trim().split(/\s+/);
  return parts.length ? parts : undefined;
}

export function enabledAcpAgents(): AcpAgentConfig[] {
  const enabled = process.env.MACHINECTL_ENABLE_ACP === "1" || process.env.MACHINECTL_ENABLE_ACP === "true";
  if (!enabled) return [];
  const requested = (process.env.MACHINECTL_ACP_AGENTS ?? "opencode")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return requested.flatMap((id) => {
    const base = BUILT_IN_AGENTS.find((agent) => agent.id === id);
    const override = envCommandOverride(id);
    if (!base && !override) return [];
    const config: AcpAgentConfig = base
      ? { ...base, command: override ?? base.command }
      : { id, label: id, command: override!, note: "Custom ACP agent from MACHINECTL_ACP_COMMAND override." };
    return [config];
  });
}

export type PendingPermission = {
  requestId: string;
  rpcId: unknown;
  askedAt: number;
  expiresAt: number;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name: string }>;
  timer: NodeJS.Timeout;
};

type AcpState = {
  nextId: number;
  acpSessionId?: string;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: string[];
  availableModes?: string[];
  currentMode?: string;
  permissionDecisions: number;
  fsReads: number;
  fsWrites: number;
  pendingPermissions: Map<string, PendingPermission>;
  nextPermissionSeq: number;
};

function state(session: Session): AcpState {
  session.state.acp ??= {
    nextId: 1, permissionDecisions: 0, fsReads: 0, fsWrites: 0,
    pendingPermissions: new Map<string, PendingPermission>(), nextPermissionSeq: 1,
  } satisfies AcpState;
  return session.state.acp as AcpState;
}

export function pendingPermissionView(session: Session) {
  return [...state(session).pendingPermissions.values()].map((pending) => ({
    requestId: pending.requestId,
    askedAt: new Date(pending.askedAt).toISOString(),
    expiresAt: new Date(pending.expiresAt).toISOString(),
    expiresInMs: Math.max(0, pending.expiresAt - Date.now()),
    toolCall: pending.toolCall,
    options: pending.options,
  }));
}

function rpc(session: Session, method: string, params: unknown, waitMs: number): Promise<unknown> {
  if (isTerminalStatus(session.status) || session.status === "stopping") {
    throw new Error(`acp session ${session.id} is ${session.status}`);
  }
  const id = state(session).nextId++;
  return requestWithId(session, String(id), { jsonrpc: "2.0", id, method, params }, waitMs, method);
}

function enrichAuthError(session: Session, config: AcpAgentConfig, error: Error): Error {
  if (!/auth|unauthor|credential|not logged in|login/i.test(error.message)) return error;
  const methods = state(session).authMethods ?? [];
  const hint = methods.length
    ? `The agent has these authentication methods: ${methods.join(", ")}. Do this login in the CLI of the agent on this machine.`
    : "The agent has no ACP authentication methods. It needs credentials in the environment, or a login that you did before in its own CLI on this machine.";
  return new Error(`${config.id} refused the request: ${error.message}. ${hint} ${config.note}`);
}

function notify(session: Session, method: string, params: unknown): void {
  writeFrame(session, { jsonrpc: "2.0", method, params });
}

function reply(session: Session, id: unknown, result: unknown): void {
  writeFrame(session, { jsonrpc: "2.0", id, result });
}

function replyError(session: Session, id: unknown, code: number, message: string): void {
  writeFrame(session, { jsonrpc: "2.0", id, error: { code, message } });
}

function settlePermission(session: Session, id: unknown, optionId: string | undefined): void {
  state(session).permissionDecisions++;
  reply(session, id, {
    outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
  });
}

function handlePermissionRequest(session: Session, id: unknown, params: Record<string, unknown>): void {
  const raw = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
  const options = raw.map((option) => ({ optionId: String(option.optionId), kind: String(option.kind), name: String(option.name ?? option.optionId) }));
  const pick = (kinds: string[]) => options.find((option) => kinds.includes(option.kind))?.optionId;

  if (PERMISSION_POLICY !== "ask") {
    const choice = PERMISSION_POLICY === "allow" ? pick(["allow_once", "allow_always"]) : pick(["reject_once", "reject_always"]);
    pushEvent(session, {
      type: "acp_permission_request", policy: PERMISSION_POLICY,
      decision: choice ?? "cancelled", toolCall: params.toolCall ?? null, offered: options,
    });
    settlePermission(session, id, choice);
    return;
  }

  const acp = state(session);
  const requestId = `perm-${acp.nextPermissionSeq++}`;
  const askedAt = Date.now();
  const expiresAt = askedAt + PERMISSION_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (!acp.pendingPermissions.delete(requestId)) return;
    pushEvent(session, {
      type: "acp_permission_expired", requestId, policy: "ask",
      decision: pick(["reject_once", "reject_always"]) ?? "cancelled",
      waitedMs: Date.now() - askedAt, toolCall: params.toolCall ?? null,
    });
    settlePermission(session, id, pick(["reject_once", "reject_always"]));
  }, PERMISSION_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();

  acp.pendingPermissions.set(requestId, { requestId, rpcId: id, askedAt, expiresAt, toolCall: params.toolCall ?? null, options, timer });
  pushEvent(session, {
    type: "acp_permission_pending", requestId, policy: "ask",
    toolCall: params.toolCall ?? null, offered: options, expiresInMs: PERMISSION_TIMEOUT_MS,
  });
}

export function resolvePendingPermission(session: Session, requestId: string, optionId: string) {
  const acp = state(session);
  const pending = acp.pendingPermissions.get(requestId);
  if (!pending) {
    const known = [...acp.pendingPermissions.keys()];
    throw new Error(`There is no held permission request "${requestId}". These requests wait for an answer: ${known.join(", ") || "none"}`);
  }
  const allowed = pending.options.map((option) => option.optionId);
  if (optionId !== "cancel" && !allowed.includes(optionId)) {
    throw new Error(`The agent did not supply the option "${optionId}" for ${requestId}. Use one of these options: ${allowed.join(", ")}, or "cancel".`);
  }
  clearTimeout(pending.timer);
  acp.pendingPermissions.delete(requestId);
  const chosen = optionId === "cancel" ? undefined : optionId;
  pushEvent(session, {
    type: "acp_permission_resolved", requestId, policy: "ask",
    decision: chosen ?? "cancelled", waitedMs: Date.now() - pending.askedAt, toolCall: pending.toolCall,
  });
  settlePermission(session, pending.rpcId, chosen);
  return { requestId, decision: chosen ?? "cancelled", waitedMs: Date.now() - pending.askedAt };
}

async function handleFsRead(session: Session, id: unknown, params: Record<string, unknown>): Promise<void> {
  try {
    const path = await requireAllowedPath(String(params.path ?? ""), "acp fs/read_text_file path");
    const text = await readFile(path, "utf-8");
    const line = typeof params.line === "number" ? params.line : undefined;
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const content = line === undefined && limit === undefined
      ? text
      : text.split("\n").slice(line ? line - 1 : 0, limit !== undefined ? (line ? line - 1 : 0) + limit : undefined).join("\n");
    state(session).fsReads++;
    pushEvent(session, { type: "acp_fs_read", path, bytes: content.length });
    reply(session, id, { content });
  } catch (error) {
    pushEvent(session, { type: "acp_fs_read_denied", path: params.path ?? null, error: String((error as Error).message) });
    replyError(session, id, -32602, String((error as Error).message));
  }
}

async function handleFsWrite(session: Session, id: unknown, params: Record<string, unknown>): Promise<void> {
  try {
    const path = await requireAllowedPath(String(params.path ?? ""), "acp fs/write_text_file path");
    const content = String(params.content ?? "");
    await writeFile(path, content, "utf-8");
    state(session).fsWrites++;
    pushEvent(session, { type: "acp_fs_write", path, bytes: content.length });
    reply(session, id, null);
  } catch (error) {
    pushEvent(session, { type: "acp_fs_write_denied", path: params.path ?? null, error: String((error as Error).message) });
    replyError(session, id, -32602, String((error as Error).message));
  }
}

export function capabilitiesFromAgent(agentCapabilities: Record<string, unknown> | undefined): HarnessCapability[] {
  const capabilities: HarnessCapability[] = ["start", "list", "status", "logs", "prompt", "abort", "stop"];
  const sessionCaps = (agentCapabilities?.sessionCapabilities ?? {}) as Record<string, unknown>;
  if (sessionCaps.list !== undefined || agentCapabilities?.loadSession === true) capabilities.push("persisted_sessions");
  return capabilities;
}

function pickInitialMode(modes: string[]): string | undefined {
  const override = process.env.MACHINECTL_ACP_MODE?.trim();
  if (override && modes.includes(override)) return override;
  return MODE_PREFERENCE.find((mode) => modes.includes(mode)) ?? modes[0];
}

function buildAdapter(config: AcpAgentConfig): HarnessAdapter {
  const adapter: HarnessAdapter = {
    id: config.id,
    label: config.label,
    capabilities: ["start", "list", "status", "logs", "prompt", "control", "abort", "stop", "persisted_sessions"],
    controlCommands: ["set_mode", "list_modes", "session_info", "pending_permissions", "resolve_permission"],
    note: `ACP (JSON-RPC over stdio). ${config.note}`,

    async start(args: StartArgs): Promise<Session> {
      const cwd = await requireCwd(args.cwd);
      const session = registerProcess(adapter, cwd, args.title, config.command);
      const acp = state(session);

      const initialize = await rpc(session, "initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: "machinectl", version: "0.4.0" },
      }, HANDSHAKE_TIMEOUT_MS) as Record<string, unknown>;

      acp.agentCapabilities = (initialize?.agentCapabilities ?? {}) as Record<string, unknown>;
      acp.authMethods = Array.isArray(initialize?.authMethods)
        ? (initialize.authMethods as Array<Record<string, unknown>>).map((method) => String(method.id))
        : [];
      session.negotiatedCapabilities = capabilitiesFromAgent(acp.agentCapabilities);

      const created = await rpc(session, "session/new", {
        cwd,
        mcpServers: [],
      }, HANDSHAKE_TIMEOUT_MS) as Record<string, unknown>;

      acp.acpSessionId = String(created?.sessionId ?? "");
      if (!acp.acpSessionId) throw new Error(`${config.id} did not supply an ACP sessionId.`);

      const modes = created?.modes as Record<string, unknown> | undefined;
      const available = Array.isArray(modes?.availableModes)
        ? (modes!.availableModes as Array<Record<string, unknown>>).map((mode) => String(mode.id))
        : [];
      acp.availableModes = available;
      const permissionCommands = PERMISSION_POLICY === "ask" ? ["pending_permissions", "resolve_permission"] : [];
      session.negotiatedControlCommands = available.length
        ? ["set_mode", "list_modes", "session_info", ...permissionCommands]
        : ["session_info", ...permissionCommands];
      if (!session.negotiatedCapabilities.includes("control")) session.negotiatedCapabilities.push("control");

      const initialMode = available.length ? pickInitialMode(available) : undefined;
      if (initialMode && initialMode !== modes?.currentModeId) {
        await rpc(session, "session/set_mode", { sessionId: acp.acpSessionId, modeId: initialMode }, HANDSHAKE_TIMEOUT_MS)
          .catch((error) => pushEvent(session, { type: "acp_set_mode_failed", modeId: initialMode, error: String(error?.message ?? error) }));
      }
      acp.currentMode = initialMode ?? (modes?.currentModeId ? String(modes.currentModeId) : undefined);

      pushEvent(session, {
        type: "acp_ready",
        agent: initialize?.agentInfo ?? null,
        protocolVersion: initialize?.protocolVersion ?? null,
        acpSessionId: acp.acpSessionId,
        mode: acp.currentMode ?? null,
        availableModes: available,
        permissionPolicy: PERMISSION_POLICY,
        capabilities: session.negotiatedCapabilities,
        containment: available.length ? "mode-pinned" : "agent-discretion",
        ...(available.length ? {} : {
          warning: `WARNING: ${config.id} has no session modes. machinectl cannot set a mode with fewer permissions. This agent decides if it requests permission. It also decides if it sends file writes to machinectl. When it does neither, it operates with all of your user permissions, and MACHINECTL_ALLOWED_PATHS does not stop it. For remote work without a user present, use an agent that has session modes.`,
        }),
      });

      if (args.prompt) void adapter.prompt!(session, args.prompt).catch(() => {});
      return session;
    },

    onMessage(session, message) {
      if (typeof message !== "object" || message === null) { pushEvent(session, message); return; }
      const msg = message as Record<string, unknown>;

      if (msg.id !== undefined && msg.method === undefined) {
        const key = String(msg.id);
        if (msg.error) {
          const error = msg.error as Record<string, unknown>;
          pushEvent(session, { type: "acp_error", id: msg.id, error });
          if (!rejectWaiter(session, key, new Error(String(error?.message ?? "ACP error")))) {
            pushEvent(session, { type: "acp_unmatched_error", id: msg.id });
          }
          return;
        }
        resolveWaiter(session, key, msg.result);
        return;
      }

      if (msg.method !== undefined && msg.id !== undefined) {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        switch (msg.method) {
          case "session/request_permission": return handlePermissionRequest(session, msg.id, params);
          case "fs/read_text_file": void handleFsRead(session, msg.id, params); return;
          case "fs/write_text_file": void handleFsWrite(session, msg.id, params); return;
          default:
            pushEvent(session, { type: "acp_unsupported_request", method: msg.method });
            replyError(session, msg.id, -32601, `machinectl does not have the method ${String(msg.method)}.`);
            return;
        }
      }

      if (msg.method === "session/update") {
        const update = (msg.params as Record<string, unknown>)?.update as Record<string, unknown> | undefined;
        pushEvent(session, { type: "acp_update", update: update ?? msg.params });
        return;
      }
      pushEvent(session, message);
    },

    async prompt(session, message) {
      const acp = state(session);
      if (!acp.acpSessionId) throw new Error("The ACP session is not ready.");
      setStatus(session, "running");
      try {
        const result = await rpc(session, "session/prompt", {
          sessionId: acp.acpSessionId,
          prompt: [{ type: "text", text: message }],
        }, PROMPT_TIMEOUT_MS);
        setStatus(session, "idle");
        return result;
      } catch (error) {
        setStatus(session, "idle");
        throw enrichAuthError(session, config, error as Error);
      }
    },

    async control(session, command, args) {
      const acp = state(session);
      if (!acp.acpSessionId) throw new Error("The ACP session is not ready.");
      if (command === "session_info") {
        return {
          acpSessionId: acp.acpSessionId, mode: acp.currentMode ?? null, availableModes: acp.availableModes ?? [],
          agentCapabilities: acp.agentCapabilities ?? {}, authMethods: acp.authMethods ?? [], permissionPolicy: PERMISSION_POLICY,
          containment: (acp.availableModes ?? []).length ? "mode-pinned" : "agent-discretion",
          pendingPermissions: pendingPermissionView(session),
          audit: { permissionDecisions: acp.permissionDecisions, fsReads: acp.fsReads, fsWrites: acp.fsWrites },
        };
      }
      if (command === "list_modes") return { availableModes: acp.availableModes ?? [], currentMode: acp.currentMode ?? null };
      if (command === "pending_permissions") return { policy: PERMISSION_POLICY, pending: pendingPermissionView(session) };
      if (command === "resolve_permission") {
        if (PERMISSION_POLICY !== "ask") throw new Error(`The resolve_permission command needs MACHINECTL_ACP_PERMISSION=ask. The policy is now "${PERMISSION_POLICY}".`);
        const requestId = String(args.requestId ?? "");
        const optionId = String(args.optionId ?? "");
        if (!requestId || !optionId) throw new Error('The resolve_permission command needs args.requestId and args.optionId. To refuse the request, set optionId to "cancel".');
        return resolvePendingPermission(session, requestId, optionId);
      }
      if (command === "set_mode") {
        const modeId = String(args.modeId ?? "");
        if (!modeId) throw new Error("The set_mode command needs args.modeId.");
        if (!(acp.availableModes ?? []).includes(modeId)) {
          throw new Error(`${config.id} does not have the mode "${modeId}". Use one of these modes: ${(acp.availableModes ?? []).join(", ") || "none"}`);
        }
        const result = await rpc(session, "session/set_mode", { sessionId: acp.acpSessionId, modeId }, HANDSHAKE_TIMEOUT_MS);
        acp.currentMode = modeId;
        pushEvent(session, { type: "acp_mode_changed", modeId });
        return result ?? { modeId };
      }
      throw new Error(`${config.id} does not have the control command "${command}".`);
    },

    async abort(session) {
      const acp = state(session);
      if (!acp.acpSessionId) return { aborted: false };
      notify(session, "session/cancel", { sessionId: acp.acpSessionId });
      setStatus(session, "idle");
      pushEvent(session, { type: "acp_cancelled" });
      return { aborted: true };
    },

    async close(session) {
      const acp = state(session);
      if (!acp.acpSessionId) return { closed: false };
      const caps = (acp.agentCapabilities?.sessionCapabilities ?? {}) as Record<string, unknown>;
      if (caps.close === undefined) return { closed: false, reason: "The agent does not have the session/close method." };
      return rpc(session, "session/close", { sessionId: acp.acpSessionId }, 5_000)
        .then(() => ({ closed: true }))
        .catch(() => ({ closed: false }));
    },
  };
  return adapter;
}

export function buildAcpAdapters(): HarnessAdapter[] {
  return enabledAcpAgents().map(buildAdapter);
}
