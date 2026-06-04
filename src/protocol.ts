// protocol.ts — wire format shared between the laptop daemon and a
// compatible Worker-side MachineHost Durable Object.
//
// Keep this file in dependency-free sync with your Worker implementation.
// If you change a frame shape there, change it here too.

import type { ZodSchema } from "zod";

/** A single tool the daemon publishes on `hello`. Mirrors MCP's
 *  tools/list response item shape so the Worker echoes them through to
 *  MCP clients without translation. */
export interface PublishedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Tool handler signature on the daemon side. Receives parsed args
 *  (Zod-validated against inputSchema), returns a string the Worker
 *  forwards back as `content[0].text`. Throw to send an error result. */
export type ToolHandler<Args = Record<string, unknown>> = (
  args: Args,
) => Promise<string> | string;

/** Daemon-side tool registry entry. `inputSchemaJson` is the JSON-Schema
 *  the Worker sends to MCP clients; `validator` is the Zod schema we
 *  use locally to parse the args before invoking `handler`. */
export interface RegisteredTool<S extends ZodSchema = ZodSchema> {
  name: string;
  description: string;
  inputSchemaJson: Record<string, unknown>;
  validator: S;
  handler: ToolHandler;
}

// ─── frames ───────────────────────────────────────────────────────────────

/** UP: daemon → Worker. */
export interface ResultMetrics {
  toolExecMs: number;
  resultBytes: number;
}

export type LaptopFrame =
  | { type: "hello"; machineName: string; tools: PublishedTool[] }
  | { type: "result"; id: string; ok: true; content: string; metrics?: ResultMetrics }
  | { type: "result"; id: string; ok: false; error: string; metrics?: ResultMetrics }
  | { type: "pong" };

/** DOWN: Worker → daemon. */
export type WorkerFrame =
  | { type: "call"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "ping" }
  | { type: "pong" };
