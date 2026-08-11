import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

function agentsUnder(env) {
  const source = `
    const { enabledAcpAgents } = await import("./dist/harness/acp.js");
    try { console.log(JSON.stringify({ ok: enabledAcpAgents().map((agent) => agent.id) })); }
    catch (error) { console.log(JSON.stringify({ error: String(error.message ?? error) })); }
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, MACHINECTL_ACP_PERMISSION: "", MACHINECTL_ACP_ALLOW_UNGOVERNED: "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return JSON.parse(stdout);
}

function capabilitiesUnder(env) {
  const source = `
    const { advertisedClientCapabilities } = await import("./dist/harness/acp.js");
    console.log(JSON.stringify(advertisedClientCapabilities()));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, MACHINECTL_ACP_PERMISSION: "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return JSON.parse(stdout);
}

test("an agent that cannot be governed is refused while a policy claims to restrict it", () => {
  const result = agentsUnder({
    MACHINECTL_ENABLE_ACP: "1",
    MACHINECTL_ACP_AGENTS: "opencode",
    MACHINECTL_ACP_PERMISSION: "deny",
  });
  assert.ok(result.error, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.match(result.error, /opencode/);
  assert.match(result.error, /MACHINECTL_ACP_ALLOW_UNGOVERNED/);
});

test("a governable agent is still enabled under a restrictive policy", () => {
  const result = agentsUnder({
    MACHINECTL_ENABLE_ACP: "1",
    MACHINECTL_ACP_AGENTS: "codex",
    MACHINECTL_ACP_PERMISSION: "deny",
  });
  assert.deepEqual(result.ok, ["codex"]);
});

test("an ungovernable agent may be enabled with an explicit acknowledgement", () => {
  const result = agentsUnder({
    MACHINECTL_ENABLE_ACP: "1",
    MACHINECTL_ACP_AGENTS: "opencode",
    MACHINECTL_ACP_PERMISSION: "deny",
    MACHINECTL_ACP_ALLOW_UNGOVERNED: "1",
  });
  assert.deepEqual(result.ok, ["opencode"]);
});

test("an ungovernable agent is allowed when the policy does not claim to restrict it", () => {
  const result = agentsUnder({
    MACHINECTL_ENABLE_ACP: "1",
    MACHINECTL_ACP_AGENTS: "opencode",
    MACHINECTL_ACP_PERMISSION: "allow",
  });
  assert.deepEqual(result.ok, ["opencode"]);
});

test("a mixed roster names every ungovernable agent in one refusal", () => {
  const result = agentsUnder({
    MACHINECTL_ENABLE_ACP: "1",
    MACHINECTL_ACP_AGENTS: "codex,opencode,amp",
    MACHINECTL_ACP_PERMISSION: "deny",
  });
  assert.ok(result.error, `expected a refusal, got ${JSON.stringify(result)}`);
  assert.match(result.error, /opencode/);
  assert.match(result.error, /amp/);
  assert.equal(/codex/.test(result.error), false, "a governable agent must not be blamed");
});

test("a refusing policy does not offer to write files", () => {
  const capabilities = capabilitiesUnder({ MACHINECTL_ACP_PERMISSION: "deny" });
  assert.equal(capabilities.fs.writeTextFile, false, "a denying relay must not advertise a write capability");
  assert.equal(capabilities.fs.readTextFile, true, "reading stays bounded by MACHINECTL_ALLOWED_PATHS");
  assert.equal(capabilities.terminal, false);
});

test("an allowing policy offers the write capability", () => {
  const capabilities = capabilitiesUnder({ MACHINECTL_ACP_PERMISSION: "allow" });
  assert.equal(capabilities.fs.writeTextFile, true);
});
