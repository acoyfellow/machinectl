import { createInterface } from "node:readline";

const tools = [
  { name: "apps", description: "List running apps", inputSchema: { type: "object", properties: {} } },
  { name: "act", description: "Click a control", inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } },
];

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} } });
  if (message.method === "tools/list") return reply(message.id, { tools });
  if (message.method !== "tools/call") return;
  const { name, arguments: args } = message.params;
  if (name === "apps") return reply(message.id, { content: [{ type: "text", text: "In front: Finder\nFinder" }], isError: false });
  if (name === "act" && !args.app) return reply(message.id, { content: [{ type: "text", text: "hand error: app is required" }], isError: true });
  return reply(message.id, { content: [{ type: "text", text: `did ${name} in ${args.app}` }], isError: false });
});
