import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.MACHINECTL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "machinectl-pair-"));
const { pairMachine, readPairedMachine, pairedMachinePath, launchAgentPlist, writeLaunchAgent, LAUNCH_AGENT_LABEL } = await import("../dist/pairing.js");
const { HandClient, handToolsFor } = await import("../dist/hand-adapter.js");

test("pairing posts the code and name, then saves a private credential", async () => {
  let sent;
  const fetcher = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, name: "mac-a", credential: "mxm_secret" }), { status: 201 });
  };
  const machine = await pairMachine("http://localhost:8790/", "ABCD-EFGH", "mac-a", fetcher);
  assert.equal(sent.url, "http://localhost:8790/machines/pair");
  assert.deepEqual(sent.body, { code: "ABCD-EFGH", name: "mac-a" });
  assert.deepEqual(machine, { url: "http://localhost:8790", name: "mac-a", credential: "mxm_secret" });
  assert.deepEqual(readPairedMachine(), machine);
  assert.equal(statSync(pairedMachinePath()).mode & 0o777, 0o600);
});

test("a refused code surfaces the server's message and saves nothing new", async () => {
  const fetcher = async () => new Response(JSON.stringify({ ok: false, error: { message: "This pairing code is unknown, already used or expired." } }), { status: 400 });
  await assert.rejects(pairMachine("http://localhost:8790", "BAD", "mac-z", fetcher), /already used or expired/);
  assert.equal(readPairedMachine().name, "mac-a");
});

test("the launch agent keeps the daemon alive and the Mac awake", () => {
  const plist = launchAgentPlist("/usr/local/bin/node", "/opt/machinectl/dist/index.js", "/tmp/logs", { MACHINECTL_ENABLE_HAND: "1", HOME: "/Users/a&b" });
  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-is<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /\/Users\/a&amp;b/);
  const dir = mkdtempSync(join(tmpdir(), "launch-agents-"));
  const path = writeLaunchAgent(plist, dir);
  assert.equal(readFileSync(path, "utf8"), plist);
});

test("hand tools are published with a prefix and forward calls to hand", async () => {
  const client = new HandClient(process.execPath, [new URL("./fixtures/fake-hand.mjs", import.meta.url).pathname]);
  const tools = handToolsFor(client, await client.start());
  try {
    assert.deepEqual(tools.map((tool) => tool.name), ["hand_apps", "hand_act"]);
    assert.equal(await tools[0].handler({}), "In front: Finder\nFinder");
    assert.equal(await tools[1].handler({ app: "Notes" }), "did act in Notes");
    await assert.rejects(tools[1].handler({}), /app is required/);
  } finally {
    client.stop();
  }
});

test("the launch agent only lets the agent run terminal commands when --shell is given", async () => {
  const { launchAgentEnv } = await import("../dist/commands.js");
  assert.equal(launchAgentEnv(false).MACHINECTL_ENABLE_SHELL, undefined);
  const shell = launchAgentEnv(true);
  assert.equal(shell.MACHINECTL_ENABLE_SHELL, "1");
  assert.equal(shell.MACHINECTL_ALLOWED_PATHS, shell.HOME);
});
