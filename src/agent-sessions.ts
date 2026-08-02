import { z } from "zod";
import type { RegisteredTool, ToolHandler } from "./protocol.js";
import {
  allSessions, hasConfiguredPathRoots, mustGetSession, MAX_SESSIONS, OUTPUT_CAP,
  publicSession, SESSION_MAX_RUNTIME_MS, stopSession, trimFinishedSessions,
} from "./harness/runtime.js";
import {
  findPersistedPiSessions, piAdapter, PI_CONTROL_COMMANDS, sendPi, validatePiControlArgs,
} from "./harness/pi.js";
import { sessionCapabilities, sessionControlCommands, type HarnessAdapter, type Session } from "./harness/types.js";

export { shutdownAgentSessions } from "./harness/runtime.js";

const PI_TOOLS_ENABLED = process.env.MACHINECTL_ENABLE_PI === "1" || process.env.MACHINECTL_ENABLE_PI === "true";

function resolveAdapters(): HarnessAdapter[] {
  return [
    ...(PI_TOOLS_ENABLED ? [piAdapter] : []),
  ];
}

function json(value: unknown): string { return JSON.stringify(value, null, 2); }

function jsonTool<S extends z.ZodTypeAny>(name: string, description: string, schema: Record<string, unknown>, validator: S, handler: ToolHandler<z.infer<S>>): RegisteredTool<S> {
  return { name, description, inputSchemaJson: schema, validator, handler: handler as ToolHandler };
}

export function buildAgentSessionTools(): RegisteredTool[] {
  const adapters = resolveAdapters();
  if (!adapters.length || !hasConfiguredPathRoots) return [];

  const adapterIds = adapters.map((adapter) => adapter.id);
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const allControlCommands = [...new Set(adapters.flatMap((adapter) => [...(adapter.controlCommands ?? [])]))];

  const requireCapability = (id: string, capability: string): Session => {
    const session = mustGetSession(id);
    if (!sessionCapabilities(session).includes(capability as never)) {
      throw new Error(`The harness ${session.harnessId} does not have the ${capability} capability.`);
    }
    return session;
  };
  const requireMethod = <K extends keyof HarnessAdapter>(session: Session, method: K, capability: string) => {
    const fn = session.adapter[method];
    if (typeof fn !== "function") throw new Error(`The harness ${session.harnessId} does not have the ${capability} capability.`);
    return fn as NonNullable<HarnessAdapter[K]>;
  };

  const catalog = () => adapters.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    capabilities: adapter.capabilities,
    ...(adapter.controlCommands ? { controlCommands: [...adapter.controlCommands] } : {}),
    ...(adapter.note ? { note: adapter.note } : {}),
  }));

  const sessionValidator = z.object({ harnessId: z.string().optional(), id: z.string() });
  const sessionSchema = { type: "object", properties: { harnessId: { type: "string", enum: adapterIds }, id: { type: "string" } }, required: ["id"] };

  const piTools: RegisteredTool[] = PI_TOOLS_ENABLED ? [
    jsonTool("pi_start", `Start a live local pi RPC session inside configured paths. Maximum ${MAX_SESSIONS} active sessions; maximum runtime ${SESSION_MAX_RUNTIME_MS}ms.`, {
      type: "object", properties: { cwd: { type: "string" }, title: { type: "string" }, model: { type: "string" }, thinking: { type: "string" }, continueRecent: { type: "boolean" }, session: { type: "string" } }, required: ["cwd"],
    }, z.object({ cwd: z.string().min(1), title: z.string().optional(), model: z.string().optional(), thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(), continueRecent: z.boolean().optional(), session: z.string().optional() }), async (args) => json({ session: publicSession(await piAdapter.start(args)) })),
    jsonTool("pi_list", "List active/recent pi sessions; optionally include persisted pi sessions whose project cwd is permitted.", { type: "object", properties: { includePersisted: { type: "boolean" }, limit: { type: "number" } } }, z.object({ includePersisted: z.boolean().optional().default(false), limit: z.number().int().min(1).max(50).optional().default(20) }), async ({ includePersisted, limit }) => {
      trimFinishedSessions();
      return json({ sessions: allSessions().filter((session) => session.harnessId === "pi").map(publicSession).slice(-limit), ...(includePersisted ? { persisted: await findPersistedPiSessions(limit) } : {}), limits: { maxConcurrentSessions: MAX_SESSIONS, maxRuntimeMs: SESSION_MAX_RUNTIME_MS } });
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

  return [
    jsonTool("harness_catalog", "List available local delegated-agent harnesses and their honest capabilities.", { type: "object", properties: {} }, z.object({}).strict(), async () => json({ harnesses: catalog() })),

    jsonTool("harness_start", "Start a local delegated-agent harness session.", { type: "object", properties: { harnessId: { type: "string", enum: adapterIds }, cwd: { type: "string" }, prompt: { type: "string" }, title: { type: "string" }, model: { type: "string" }, thinking: { type: "string" }, continueRecent: { type: "boolean" }, session: { type: "string" } }, required: ["harnessId", "cwd"] },
      z.object({ harnessId: z.string(), cwd: z.string().min(1), prompt: z.string().optional(), title: z.string().optional(), model: z.string().optional(), thinking: z.string().optional(), continueRecent: z.boolean().optional(), session: z.string().optional() }),
      async ({ harnessId, ...args }) => {
        const adapter = byId.get(harnessId);
        if (!adapter) throw new Error(`The harness ${harnessId} is not enabled. These harnesses are available: ${adapterIds.join(", ") || "none"}`);
        const session = await adapter.start(args);
        return json({ session: publicSession(session), capabilities: sessionCapabilities(session) });
      }),

    jsonTool("harness_list", "List active/recent local delegated-agent harness sessions.", { type: "object", properties: { harnessId: { type: "string", enum: adapterIds }, limit: { type: "number" } } },
      z.object({ harnessId: z.string().optional(), limit: z.number().int().min(1).max(50).optional().default(20) }),
      async ({ harnessId, limit }) => {
        trimFinishedSessions();
        return json({ sessions: allSessions().filter((session) => !harnessId || session.harnessId === harnessId).map(publicSession).slice(-limit) });
      }),

    jsonTool("harness_status", "Get normalized status and recent events for a local delegated-agent harness session.", { ...sessionSchema, properties: { ...sessionSchema.properties, eventLimit: { type: "number" } } },
      sessionValidator.extend({ eventLimit: z.number().int().min(0).max(100).optional().default(20) }),
      async ({ id, eventLimit }) => {
        const session = mustGetSession(id);
        return json({ session: publicSession(session), capabilities: sessionCapabilities(session), recentEvents: session.events.slice(-eventLimit) });
      }),

    jsonTool("harness_logs", "Read bounded logs from a local delegated-agent harness session.", { ...sessionSchema, properties: { ...sessionSchema.properties, tailChars: { type: "number" } } },
      sessionValidator.extend({ tailChars: z.number().int().min(1).max(OUTPUT_CAP).optional().default(20000) }),
      async ({ id, tailChars }) => mustGetSession(id).output.slice(-tailChars) || "(no output yet)"),

    jsonTool("harness_prompt", "Send a prompt when the selected harness supports it.", { ...sessionSchema, properties: { ...sessionSchema.properties, message: { type: "string" } }, required: ["id", "message"] },
      sessionValidator.extend({ message: z.string().min(1) }),
      async ({ id, message }) => { const session = requireCapability(id, "prompt"); return json(await requireMethod(session, "prompt", "prompt")(session, message)); }),

    jsonTool("harness_steer", "Queue steering guidance when the selected harness supports it.", { ...sessionSchema, properties: { ...sessionSchema.properties, message: { type: "string" } }, required: ["id", "message"] },
      sessionValidator.extend({ message: z.string().min(1) }),
      async ({ id, message }) => { const session = requireCapability(id, "steer"); return json(await requireMethod(session, "steer", "steer")(session, message)); }),

    jsonTool("harness_follow_up", "Queue follow-up work when the selected harness supports it.", { ...sessionSchema, properties: { ...sessionSchema.properties, message: { type: "string" } }, required: ["id", "message"] },
      sessionValidator.extend({ message: z.string().min(1) }),
      async ({ id, message }) => { const session = requireCapability(id, "follow_up"); return json(await requireMethod(session, "followUp", "follow_up")(session, message)); }),

    jsonTool("harness_control", "Issue an allow-listed adapter-specific control command when supported.", { ...sessionSchema, properties: { ...sessionSchema.properties, command: { type: "string", enum: allControlCommands }, args: { type: "object" } }, required: ["id", "command"] },
      sessionValidator.extend({ command: z.string().min(1), args: z.record(z.unknown()).optional().default({}) }),
      async ({ id, command, args }) => {
        const session = requireCapability(id, "control");
        const allowed = sessionControlCommands(session);
        if (!allowed.includes(command)) throw new Error(`The harness ${session.harnessId} does not permit the control command "${command}". These commands are permitted: ${allowed.join(", ") || "none"}`);
        return json(await requireMethod(session, "control", "control")(session, command, args));
      }),

    jsonTool("harness_abort", "Abort current work when the selected harness supports it.", sessionSchema, sessionValidator,
      async ({ id }) => { const session = requireCapability(id, "abort"); return json(await requireMethod(session, "abort", "abort")(session)); }),

    jsonTool("harness_stop", "Stop a local delegated-agent harness session and retain bounded logs.", sessionSchema, sessionValidator,
      async ({ id }) => {
        const session = requireCapability(id, "stop");
        if (typeof session.adapter.close === "function") await session.adapter.close(session).catch(() => undefined);
        stopSession(session, "stopped", "Harness session stopped by remote caller.");
        return json({ session: publicSession(session) });
      }),

    ...piTools,
  ];
}
