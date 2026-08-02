import { createInterface } from "node:readline";

const modes = (process.env.FAKE_MODES ?? "").split(",").map((m) => m.trim()).filter(Boolean);
const emit = process.env.FAKE_EMIT ?? "";
const fsPath = process.env.FAKE_FS_PATH ?? "";

let nextId = 1000;
const pending = new Map();

const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (update) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-1", update } });

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });
}

async function afterSessionNew() {
  if (emit === "permission") {
    const reply = await request("session/request_permission", {
      sessionId: "fake-1",
      toolCall: { toolCallId: "t1", title: "rm -rf /", kind: "execute" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    notify({ sessionUpdate: "fake_permission_result", reply });
  }
  if (emit === "fs_read") {
    const reply = await request("fs/read_text_file", { sessionId: "fake-1", path: fsPath });
    notify({ sessionUpdate: "fake_fs_read_result", reply });
  }
  if (emit === "fs_write") {
    const reply = await request("fs/write_text_file", { sessionId: "fake-1", path: fsPath, content: "written-by-agent" });
    notify({ sessionUpdate: "fake_fs_write_result", reply });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.error ? { error: msg.error } : { result: msg.result ?? null });
    }
    return;
  }

  if (msg.method === "initialize") {
    write({
      jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: 1,
        agentInfo: { name: "fake-acp", version: "0.0.1" },
        agentCapabilities: {
          promptCapabilities: { image: false, embeddedContext: false },
          ...(process.env.FAKE_LOAD_SESSION === "1" ? { loadSession: true } : {}),
          ...(process.env.FAKE_SESSION_CAPS === "1" ? { sessionCapabilities: { list: {}, close: {} } } : {}),
        },
      },
    });
    return;
  }

  if (msg.method === "session/new") {
    write({
      jsonrpc: "2.0", id: msg.id, result: {
        sessionId: "fake-1",
        ...(modes.length ? { modes: { currentModeId: modes[0], availableModes: modes.map((id) => ({ id, name: id })) } } : {}),
      },
    });
    setTimeout(() => { void afterSessionNew(); }, 20);
    return;
  }

  if (msg.method === "session/set_mode") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
    notify({ sessionUpdate: "fake_mode_set", modeId: msg.params?.modeId });
    return;
  }

  if (msg.method === "session/prompt") {
    write({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }

  if (msg.method === "session/close") {
    write({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `The fake agent does not have the method ${msg.method}.` } });
});
