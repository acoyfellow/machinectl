import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink as makeSymlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const FAKE_AGENT = resolve("test/fixtures/fake-acp-agent.mjs");

function runIsolated(source, env = {}) {
  return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, MACHINECTL_LOG_TIMING: "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  }).trim();
}

const scenarioSource = (cwd, calls = "") => `
import { buildToolRegistry } from './dist/tools.js';
const tools = buildToolRegistry();
const call = async (n, a = {}) => tools.find(t => t.name === n).handler(a);
const attempt = async (n, a) => { try { return { ok: true, value: await call(n, a) }; } catch (e) { return { ok: false, error: e.message }; } };
const catalog = JSON.parse(await call('harness_catalog'));
const started = JSON.parse(await call('harness_start', { harnessId: 'fake', cwd: ${JSON.stringify(cwd)} }));
const id = started.session.id;
await new Promise(r => setTimeout(r, 400));
const status = JSON.parse(await call('harness_status', { id, eventLimit: 100 }));
const extra = {};
${calls}
console.log(JSON.stringify({ catalog, capabilities: started.capabilities, events: status.recentEvents, extra }));
await call('harness_stop', { id }).catch(() => {});
process.exit(0);
`;

function acpEnv(cwd, extra = {}) {
  return {
    MACHINECTL_ALLOWED_PATHS: cwd,
    MACHINECTL_ENABLE_ACP: "1",
    MACHINECTL_ACP_AGENTS: "fake",
    MACHINECTL_ACP_COMMAND_FAKE: `${process.execPath} ${FAKE_AGENT}`,
    ...extra,
  };
}

async function withWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "machinectl-acp-"));
  try { return await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

const findEvent = (events, type) => events.find((event) => event?.type === type);
const findUpdate = (events, sessionUpdate) =>
  events.find((event) => event?.type === "acp_update" && event.update?.sessionUpdate === sessionUpdate)?.update;

test("machinectl publishes an ACP adapter only when the operator enables it", async () => {
  await withWorkspace(async (cwd) => {
    const source = `import { buildToolRegistry } from './dist/tools.js'; const t = buildToolRegistry(); const c = t.find(x => x.name === 'harness_catalog'); console.log(JSON.stringify(JSON.parse(await c.handler({})).harnesses.map(h => h.id)));`;
    const ids = JSON.parse(runIsolated(source, { MACHINECTL_ALLOWED_PATHS: cwd, MACHINECTL_ENABLE_PI: "1" }));
    assert.deepEqual(ids, ["pi"], "ACP must not appear without MACHINECTL_ENABLE_ACP");
  });
});

test("machinectl refuses an unknown harnessId and lists the available harnesses", async () => {
  await withWorkspace(async (cwd) => {
    const source = `import { buildToolRegistry } from './dist/tools.js'; const t = buildToolRegistry(); const s = t.find(x => x.name === 'harness_start'); try { await s.handler({ harnessId: 'nope', cwd: ${JSON.stringify(cwd)} }); console.log(JSON.stringify({ ok: true })); } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }`;
    const result = JSON.parse(runIsolated(source, acpEnv(cwd)));
    assert.equal(result.ok, false);
    assert.match(result.error, /is not enabled/);
  });
});

test("the capabilities come from the initialize reply of the agent", async () => {
  await withWorkspace(async (cwd) => {
    const weak = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd)));
    assert.ok(!weak.capabilities.includes("persisted_sessions"), "no sessionCapabilities => no persisted_sessions");

    const strong = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd, { FAKE_SESSION_CAPS: "1" })));
    assert.ok(strong.capabilities.includes("persisted_sessions"), "sessionCapabilities => persisted_sessions");

    const listed = weak.catalog.harnesses.find((harness) => harness.id === "fake");
    assert.ok(listed.capabilities.includes("persisted_sessions"));
    assert.ok(listed.note.startsWith("ACP"));
  });
});

test("an ACP session refuses steer and follow_up, because ACP has no such method", async () => {
  await withWorkspace(async (cwd) => {
    const calls = `
      extra.steer = await attempt('harness_steer', { id, message: 'x' });
      extra.followUp = await attempt('harness_follow_up', { id, message: 'x' });
      extra.prompt = await attempt('harness_prompt', { id, message: 'x' });`;
    const result = JSON.parse(runIsolated(scenarioSource(cwd, calls), acpEnv(cwd)));
    assert.equal(result.extra.steer.ok, false);
    assert.match(result.extra.steer.error, /does not have the steer capability/);
    assert.equal(result.extra.followUp.ok, false);
    assert.equal(result.extra.prompt.ok, true, "prompt is supported and must still work");
  });
});

test("a session starts in the mode that has the fewest permissions", async () => {
  await withWorkspace(async (cwd) => {
    const env = acpEnv(cwd, { FAKE_MODES: "agent-full-access,agent,read-only" });
    const result = JSON.parse(runIsolated(scenarioSource(cwd), env));
    const ready = findEvent(result.events, "acp_ready");
    assert.equal(ready.mode, "read-only", "must pin the safest mode, not accept the agent default");
    assert.equal(ready.containment, "mode-pinned");
    assert.equal(ready.warning, undefined, "a mode-pinned session needs no warning");
    assert.equal(findUpdate(result.events, "fake_mode_set").modeId, "read-only");
  });
});

test("a user can increase the permissions, but only with an explicit command", async () => {
  await withWorkspace(async (cwd) => {
    const env = acpEnv(cwd, { FAKE_MODES: "agent-full-access,read-only" });
    const calls = `
      extra.bogus = await attempt('harness_control', { id, command: 'set_mode', args: { modeId: 'yolo' } });
      extra.escalate = await attempt('harness_control', { id, command: 'set_mode', args: { modeId: 'agent-full-access' } });
      extra.modes = await attempt('harness_control', { id, command: 'list_modes' });`;
    const result = JSON.parse(runIsolated(scenarioSource(cwd, calls), env));
    assert.equal(findEvent(result.events, "acp_ready").mode, "read-only");
    assert.equal(result.extra.bogus.ok, false, "a mode the agent never offered must be refused");
    assert.match(result.extra.bogus.error, /does not have the mode/);
    assert.equal(result.extra.escalate.ok, true);
    assert.equal(JSON.parse(result.extra.modes.value).currentMode, "agent-full-access");
  });
});

test("machinectl reports that it cannot control an agent that has no modes", async () => {
  await withWorkspace(async (cwd) => {
    const result = JSON.parse(runIsolated(scenarioSource(cwd, `extra.setMode = await attempt('harness_control', { id, command: 'set_mode', args: { modeId: 'read-only' } });`), acpEnv(cwd)));
    const ready = findEvent(result.events, "acp_ready");
    assert.equal(ready.mode, null);
    assert.equal(ready.containment, "agent-discretion");
    assert.match(ready.warning, /has no session modes/);
    assert.match(ready.warning, /all of your user permissions/);
    assert.equal(result.extra.setMode.ok, false, "set_mode must be unavailable when the agent has no modes");
    assert.match(result.extra.setMode.error, /These commands are permitted: session_info/);
  });
});

test("machinectl refuses a permission request by default", async () => {
  await withWorkspace(async (cwd) => {
    const result = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd, { FAKE_EMIT: "permission" })));
    const decision = findEvent(result.events, "acp_permission_request");
    assert.equal(decision.policy, "deny");
    assert.equal(decision.decision, "no", "must select the agent's reject option");
    const seen = findUpdate(result.events, "fake_permission_result");
    assert.equal(seen.reply.result.outcome.optionId, "no", "the agent must actually receive the rejection");
  });
});

test("machinectl approves a permission request only when the operator permits it", async () => {
  await withWorkspace(async (cwd) => {
    const env = acpEnv(cwd, { FAKE_EMIT: "permission", MACHINECTL_ACP_PERMISSION: "allow" });
    const result = JSON.parse(runIsolated(scenarioSource(cwd), env));
    const decision = findEvent(result.events, "acp_permission_request");
    assert.equal(decision.policy, "allow");
    assert.equal(decision.decision, "yes");
  });
});

test("machinectl records each permission decision with the related operation", async () => {
  await withWorkspace(async (cwd) => {
    const result = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd, { FAKE_EMIT: "permission" })));
    const decision = findEvent(result.events, "acp_permission_request");
    assert.equal(decision.toolCall.title, "rm -rf /");
    assert.deepEqual(decision.offered.map((option) => option.kind), ["allow_once", "reject_once"]);
  });
});

const askSource = (cwd, body) => `
import { buildToolRegistry } from './dist/tools.js';
const tools = buildToolRegistry();
const call = async (n, a = {}) => tools.find(t => t.name === n).handler(a);
const attempt = async (n, a) => { try { return { ok: true, value: await call(n, a) }; } catch (e) { return { ok: false, error: e.message }; } };
const started = JSON.parse(await call('harness_start', { harnessId: 'fake', cwd: ${JSON.stringify(cwd)} }));
const id = started.session.id;
await new Promise(r => setTimeout(r, 400));
const out = {};
${body}
out.events = JSON.parse(await call('harness_status', { id, eventLimit: 100 })).recentEvents;
console.log(JSON.stringify(out));
await call('harness_stop', { id }).catch(() => {});
process.exit(0);
`;

const askEnv = (cwd, extra = {}) => acpEnv(cwd, { FAKE_EMIT: "permission", MACHINECTL_ACP_PERMISSION: "ask", ...extra });

test("the ask policy holds the request and does not answer for the user", async () => {
  await withWorkspace(async (cwd) => {
    const body = `out.pending = JSON.parse((await attempt('harness_control', { id, command: 'pending_permissions' })).value);`;
    const result = JSON.parse(runIsolated(askSource(cwd, body), askEnv(cwd)));
    assert.equal(result.pending.policy, "ask");
    assert.equal(result.pending.pending.length, 1, "exactly one request must be waiting");
    const [waiting] = result.pending.pending;
    assert.equal(waiting.toolCall.title, "rm -rf /");
    assert.deepEqual(waiting.options.map((o) => o.optionId), ["yes", "no"]);
    assert.ok(waiting.expiresInMs > 0);
    assert.ok(findEvent(result.events, "acp_permission_pending"));
    assert.equal(findUpdate(result.events, "fake_permission_result"), undefined, "the agent must still be waiting");
  });
});

test("the decision of the user goes to the agent", async () => {
  await withWorkspace(async (cwd) => {
    const body = `
      const p = JSON.parse((await attempt('harness_control', { id, command: 'pending_permissions' })).value).pending[0];
      out.resolved = await attempt('harness_control', { id, command: 'resolve_permission', args: { requestId: p.requestId, optionId: 'yes' } });
      await new Promise(r => setTimeout(r, 300));`;
    const result = JSON.parse(runIsolated(askSource(cwd, body), askEnv(cwd)));
    assert.equal(result.resolved.ok, true);
    assert.equal(JSON.parse(result.resolved.value).decision, "yes");
    assert.equal(findUpdate(result.events, "fake_permission_result").reply.result.outcome.optionId, "yes");
    assert.equal(findEvent(result.events, "acp_permission_resolved").decision, "yes");
  });
});

test("a user can refuse a request, and machinectl accepts only supplied options", async () => {
  await withWorkspace(async (cwd) => {
    const body = `
      const p = JSON.parse((await attempt('harness_control', { id, command: 'pending_permissions' })).value).pending[0];
      out.bogusOption = await attempt('harness_control', { id, command: 'resolve_permission', args: { requestId: p.requestId, optionId: 'sudo' } });
      out.bogusId = await attempt('harness_control', { id, command: 'resolve_permission', args: { requestId: 'perm-999', optionId: 'yes' } });
      out.cancelled = await attempt('harness_control', { id, command: 'resolve_permission', args: { requestId: p.requestId, optionId: 'cancel' } });
      await new Promise(r => setTimeout(r, 300));`;
    const result = JSON.parse(runIsolated(askSource(cwd, body), askEnv(cwd)));
    assert.equal(result.bogusOption.ok, false);
    assert.match(result.bogusOption.error, /did not supply the option/);
    assert.equal(result.bogusId.ok, false);
    assert.match(result.bogusId.error, /There is no held permission request/);
    assert.equal(result.cancelled.ok, true);
    assert.equal(findUpdate(result.events, "fake_permission_result").reply.result.outcome.outcome, "cancelled");
  });
});

test("machinectl refuses a request that has no answer at the time limit", async () => {
  await withWorkspace(async (cwd) => {
    const body = `await new Promise(r => setTimeout(r, 6500));`;
    const env = askEnv(cwd, { MACHINECTL_ACP_PERMISSION_TIMEOUT_MS: "5000" });
    const result = JSON.parse(runIsolated(askSource(cwd, body), env));
    const expired = findEvent(result.events, "acp_permission_expired");
    assert.ok(expired, "the parked request must expire rather than wait forever");
    assert.equal(expired.decision, "no", "expiry must select the reject option, never allow");
    assert.equal(findUpdate(result.events, "fake_permission_result").reply.result.outcome.optionId, "no");
  });
});

test("the resolve_permission command is available only with the ask policy", async () => {
  await withWorkspace(async (cwd) => {
    const body = `out.attempted = await attempt('harness_control', { id, command: 'resolve_permission', args: { requestId: 'perm-1', optionId: 'yes' } });`;
    const result = JSON.parse(runIsolated(askSource(cwd, body), acpEnv(cwd, { FAKE_EMIT: "permission", MACHINECTL_ACP_PERMISSION: "deny" })));
    assert.equal(result.attempted.ok, false);
    assert.match(result.attempted.error, /does not permit the control command/);
  });
});

test("machinectl examines and records each file read of the agent", async () => {
  await withWorkspace(async (cwd) => {
    const inside = join(cwd, "inside.txt");
    await writeFile(inside, "secret-inside", "utf-8");
    const allowed = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd, { FAKE_EMIT: "fs_read", FAKE_FS_PATH: inside })));
    assert.equal(findUpdate(allowed.events, "fake_fs_read_result").reply.result.content, "secret-inside");
    assert.equal(findEvent(allowed.events, "acp_fs_read").path, await realpath(inside), "the read must leave a receipt");
  });
});

test("an agent cannot read a file that is not in the permitted directories", async () => {
  await withWorkspace(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), "machinectl-acp-outside-"));
    try {
      const secret = join(outside, "secret.txt");
      await writeFile(secret, "do-not-read", "utf-8");
      const result = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd, { FAKE_EMIT: "fs_read", FAKE_FS_PATH: secret })));
      const reply = findUpdate(result.events, "fake_fs_read_result").reply;
      assert.ok(reply.error, "the agent must get an error, not the file");
      assert.match(reply.error.message, /is not in MACHINECTL_ALLOWED_PATHS/);
      assert.ok(findEvent(result.events, "acp_fs_read_denied"), "the denial must be recorded");
      assert.equal(await readFile(secret, "utf-8"), "do-not-read");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("an agent cannot write a file that is not in the permitted directories", async () => {
  await withWorkspace(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), "machinectl-acp-outside-"));
    try {
      const target = join(outside, "payload.txt");
      const result = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd, { FAKE_EMIT: "fs_write", FAKE_FS_PATH: target })));
      assert.ok(findUpdate(result.events, "fake_fs_write_result").reply.error);
      assert.ok(findEvent(result.events, "acp_fs_write_denied"));
      await assert.rejects(readFile(target, "utf-8"), "no file may be created outside the roots");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("an agent cannot write a new file through a symlink that leaves a permitted directory", async () => {
  await withWorkspace(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), "machinectl-acp-outside-"));
    const escape = join(cwd, "escape");
    try {
      await makeSymlink(outside, escape);
      const escapedTarget = join(escape, "payload.txt");
      const rejected = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd, { FAKE_EMIT: "fs_write", FAKE_FS_PATH: escapedTarget })));
      assert.ok(findUpdate(rejected.events, "fake_fs_write_result").reply.error);
      assert.ok(findEvent(rejected.events, "acp_fs_write_denied"));
      await assert.rejects(readFile(join(outside, "payload.txt"), "utf-8"));

      const allowedTarget = join(cwd, "payload.txt");
      const allowed = JSON.parse(runIsolated(scenarioSource(cwd), acpEnv(cwd, { FAKE_EMIT: "fs_write", FAKE_FS_PATH: allowedTarget })));
      assert.equal(findUpdate(allowed.events, "fake_fs_write_result").reply.result, null);
      assert.equal(await readFile(allowedTarget, "utf-8"), "written-by-agent");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("session_info reports the policy and the counts of recorded operations", async () => {
  await withWorkspace(async (cwd) => {
    const calls = `extra.info = await attempt('harness_control', { id, command: 'session_info' });`;
    const result = JSON.parse(runIsolated(scenarioSource(cwd, calls), acpEnv(cwd, { FAKE_EMIT: "fs_read", FAKE_FS_PATH: join(cwd, "missing.txt") })));
    const info = JSON.parse(result.extra.info.value);
    assert.equal(info.permissionPolicy, "deny");
    assert.equal(typeof info.audit.fsReads, "number");
    assert.equal(info.acpSessionId, "fake-1");
  });
});
