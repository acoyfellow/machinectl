import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.MACHINECTL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "machinectl-pair-"));
const { writeMachineConfig, readMachineConfig, machineConfigPath, machineConnectUrl, refusalIsFinal, logOutMachine, launchAgentPlist, writeLaunchAgent, LAUNCH_AGENT_LABEL } = await import("../dist/pairing.js");
const { HandClient, handToolsFor } = await import("../dist/hand-adapter.js");
const { launchAgentEnv, defaultMachineName, stopLaunchAgent } = await import("../dist/commands.js");

test("the machine config keeps only the url and name, never a secret, and is private", () => {
  writeMachineConfig({ url: "https://my.ax.example/", name: "air" });
  assert.deepEqual(readMachineConfig(), { url: "https://my.ax.example", name: "air" });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(machineConfigPath(), "utf8"))).sort(), ["name", "url"]);
  assert.equal(statSync(machineConfigPath()).mode & 0o777, 0o600);
});

test("a config with a bad machine name is ignored", () => {
  writeFileSync(machineConfigPath(), JSON.stringify({ url: "https://x", name: "Bad Name" }));
  assert.equal(readMachineConfig(), null);
});

test("each machine connects through the login-protected machinectl path with its own name", () => {
  assert.equal(machineConnectUrl("https://my.ax.example/", "air"), "wss://my.ax.example/machinectl/connect?machine=air");
  assert.equal(machineConnectUrl("http://localhost:8799", "studio"), "ws://localhost:8799/machinectl/connect?machine=studio");
  assert.doesNotMatch(machineConnectUrl("https://x", "a"), /\/machines\//);
});

test("only a 403 that says pending or logged out stops the normal reconnect loop", () => {
  assert.equal(refusalIsFinal(403, "logged_out"), true);
  assert.equal(refusalIsFinal(403, "pending"), true);
  assert.equal(refusalIsFinal(403, undefined), false);
  assert.equal(refusalIsFinal(502, "logged_out"), false);
});

test("logging another machine out sends the login token to the logout route", async () => {
  let sent;
  const fetcher = async (url, init) => {
    sent = { url, method: init.method, token: init.headers["cf-access-token"] };
    return new Response(JSON.stringify({ ok: true, loggedOut: "air" }));
  };
  await logOutMachine("https://my.ax.example/", "air", "jwt-1", fetcher);
  assert.deepEqual(sent, { url: "https://my.ax.example/api/machines/air/logout", method: "POST", token: "jwt-1" });
  const refused = async () => new Response(JSON.stringify({ ok: false, error: { message: "No machine with that name." } }), { status: 404 });
  await assert.rejects(logOutMachine("https://x", "nope", "jwt", refused), /No machine with that name/);
});

test("the launch agent restarts on crashes but stays off after a clean logout exit", () => {
  const plist = launchAgentPlist("/usr/local/bin/node", "/opt/machinectl/dist/index.js", "/tmp/logs", { MACHINECTL_ENABLE_HAND: "1", HOME: "/Users/a&b" });
  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.match(plist, /<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-is<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /\/Users\/a&amp;b/);
  const dir = mkdtempSync(join(tmpdir(), "launch-agents-"));
  const path = writeLaunchAgent(plist, dir);
  assert.equal(readFileSync(path, "utf8"), plist);
  assert.equal(stopLaunchAgent(path), true);
  assert.equal(stopLaunchAgent(path), false);
});

test("the launch agent only lets the agent run terminal commands when --shell is given", () => {
  assert.equal(launchAgentEnv(false).MACHINECTL_ENABLE_SHELL, undefined);
  const shell = launchAgentEnv(true);
  assert.equal(shell.MACHINECTL_ENABLE_SHELL, "1");
  assert.equal(shell.MACHINECTL_ALLOWED_PATHS, shell.HOME);
});

test("the default machine name is a safe slug of the host name", () => {
  assert.equal(defaultMachineName("Jordans-MacBook-Air-2.local"), "jordans-macbook-air-2");
  assert.equal(defaultMachineName("My Mac!!"), "my-mac");
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

test("the login item keeps the WARP certificate settings and turns on log timestamps", () => {
  const saved = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = "/tmp/warp.pem";
  try {
    const env = launchAgentEnv(false);
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/warp.pem");
    assert.equal(env.MACHINECTL_LOG_TIMESTAMP, "1");
  } finally {
    if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = saved;
  }
});
