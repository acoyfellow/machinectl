import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const surfaceId = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "machinectl-cmux-"));
  const binary = join(root, "cmux");
  const store = join(root, "pi.json");
  const calls = join(root, "calls.jsonl");
  await writeFile(binary, `#!/bin/sh
printf '%s\\n' "$*" >> "$MACHINECTL_CMUX_TEST_CALLS"
case "$*" in
  *"tree --all"*) cat <<'JSON'
{"windows":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","workspaces":[{"id":"${workspaceId}","ref":"workspace:1","title":"Idea","selected":true,"panes":[{"surfaces":[{"id":"${surfaceId}","ref":"surface:1","title":"Pi","type":"terminal","selected":true}]}]}]}]}
JSON
  ;;
  *"read-screen"*) printf 'bounded terminal tail\\n' ;;
  *) printf '{}\\n' ;;
esac
`);
  await chmod(binary, 0o700);
  await writeFile(store, JSON.stringify({ sessions: { session: { sessionId: "33333333-3333-4333-8333-333333333333", workspaceId, surfaceId, cwd: "/tmp", pid: process.pid, runtimeStatus: "idle", agentLifecycle: "idle", lastBody: "done", updatedAt: Date.now() / 1000 } } }));
  return { root, binary, store, calls };
}

function invoke(env, tool, args) {
  const source = `import { buildToolRegistry } from './dist/tools.js'; const tools = buildToolRegistry(); const tool = tools.find(t => t.name === ${JSON.stringify(tool)}); try { console.log(JSON.stringify({names: tools.map(t => t.name), ok: true, value: JSON.parse(await tool.handler(${JSON.stringify(args)}))})); } catch (error) { console.log(JSON.stringify({names: tools.map(t => t.name), ok: false, error: error.message})); }`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8", timeout: 15_000 }));
}

test("cmux tools are opt-in", () => {
  const source = `import { buildToolRegistry } from './dist/tools.js'; console.log(JSON.stringify(buildToolRegistry().map(t => t.name).filter(n => n.startsWith('cmux_'))));`;
  const names = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: process.cwd(), env: { ...process.env, MACHINECTL_ENABLE_CMUX: "0" }, encoding: "utf8" }));
  assert.deepEqual(names, []);
});

test("cmux workspace discovery joins layout with the Pi hook store", async () => {
  const value = await fixture();
  try {
    const result = invoke({ MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls, MACHINECTL_CMUX_ENV_PASSTHROUGH: "MACHINECTL_CMUX_TEST_CALLS" }, "cmux_workspace_list", {});
    assert.equal(result.ok, true);
    assert.ok(result.names.includes("cmux_pi_prompt"));
    assert.equal(result.value.workspaces[0].id, workspaceId);
    assert.equal(result.value.workspaces[0].piSessions[0].surfaceId, surfaceId);
    assert.equal(result.value.workspaces[0].piSessions[0].lastAssistantText, "done");
    assert.equal(typeof result.value.workspaces[0].piSessions[0].dispatchable, "boolean");
    assert.ok("reason" in result.value.workspaces[0].piSessions[0]);
    assert.equal(typeof result.value.workspaces[0].piSessions[0].generation, "number");
    const listed = result.value.workspaces[0];
    const status = invoke({ MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls, MACHINECTL_CMUX_ENV_PASSTHROUGH: "MACHINECTL_CMUX_TEST_CALLS" }, "cmux_workspace_status", { workspaceId });
    assert.equal(status.ok, true);
    assert.deepEqual(status.value.workspace.piSessions, listed.piSessions);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("cmux adapter rejects stale workspace IDs before mutation", async () => {
  const value = await fixture();
  try {
    const result = invoke({ MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls, MACHINECTL_CMUX_ENV_PASSTHROUGH: "MACHINECTL_CMUX_TEST_CALLS" }, "cmux_workspace_focus", { workspaceId: "99999999-9999-4999-8999-999999999999" });
    assert.equal(result.ok, false);
    assert.match(result.error, /Unknown or stale/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

// A dead pid: spawn a short-lived process, capture its pid, let it exit. Any pid
// that is not currently a live Pi is "stale" for resolution purposes.
function deadPid() {
  // pid 1 is init/launchd — alive but not a Pi, so processIsPi() rejects it via
  // the command check. That models a stale historical row deterministically.
  return 1;
}

// Store fixture: N stale rows on the SAME surface (dead/non-Pi pids) plus one
// fresh live session (this test process, which /bin/ps reports for the stub).
async function staleFixture({ freshSessionId, staleCount = 4 }) {
  const root = await mkdtemp(join(tmpdir(), "machinectl-cmux-stale-"));
  const binary = join(root, "cmux");
  const store = join(root, "pi.json");
  const calls = join(root, "calls.jsonl");
  // Fake ps: report a Pi command line ONLY for this test process's pid (the
  // fresh live row); anything else (the stale pid 1) reports a non-Pi command,
  // so processIsPi() rejects it. Mirrors how the real /bin/ps discriminates.
  const psBin = join(root, "ps");
  await writeFile(psBin, `#!/bin/sh
# argv: -p <pid> -o command=\npid="$2"
if [ "$pid" = "${process.pid}" ]; then printf '/usr/local/bin/pi\\n'; else printf 'launchd\\n'; fi
`);
  await chmod(psBin, 0o700);
  await writeFile(binary, `#!/bin/sh
printf '%s\\n' "$*" >> "$MACHINECTL_CMUX_TEST_CALLS"
case "$*" in
  *"tree --all"*) cat <<'JSON'
{"windows":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","workspaces":[{"id":"${workspaceId}","ref":"workspace:1","title":"Lee","selected":true,"panes":[{"surfaces":[{"id":"${surfaceId}","ref":"surface:1","title":"Pi","type":"terminal","selected":true}]}]}]}]}
JSON
  ;;
  *"read-screen"*) printf 'bounded terminal tail\\n' ;;
  *) printf '{}\\n' ;;
esac
`);
  await chmod(binary, 0o700);
  const sessions = {};
  for (let i = 0; i < staleCount; i++) {
    const sid = `dead000${i}-0000-4000-8000-00000000000${i}`;
    // Stale rows carry the SAME surfaceId — the exact repro. Fresher updatedAt
    // than the live row too, to prove liveness (not recency) is the primary key.
    sessions[`stale-${i}`] = { sessionId: sid, workspaceId, surfaceId, cwd: "/tmp", pid: deadPid(), runtimeStatus: "idle", agentLifecycle: "idle", lastBody: `stale ${i}`, updatedAt: Date.now() / 1000 + 100 };
  }
  sessions["fresh"] = { sessionId: freshSessionId, workspaceId, surfaceId, cwd: "/tmp", pid: process.pid, runtimeStatus: "idle", agentLifecycle: "idle", lastBody: "fresh", updatedAt: Date.now() / 1000 };
  await writeFile(store, JSON.stringify({ sessions }));
  return { root, binary, store, calls, psBin };
}

test("surface-targeted ops resolve to the current live Pi despite many stale rows on the same surface (repro)", async () => {
  const freshSessionId = "019e4aeb-bfd3-7cb8-82c3-9b8c799f4c6e";
  const value = await staleFixture({ freshSessionId });
  try {
    const env = { MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls, MACHINECTL_CMUX_ENV_PASSTHROUGH: "MACHINECTL_CMUX_TEST_CALLS", MACHINECTL_CMUX_PS_BIN: value.psBin };
    // Before the fix this threw "Multiple Pi sessions match; provide surfaceId."
    const tail = invoke(env, "cmux_surface_tail", { workspaceId, surfaceId, lines: 10 });
    assert.equal(tail.ok, true, tail.error);
    assert.equal(tail.value.sessionId, freshSessionId, "tail must target the live session, never a stale row");
    // prompt resolves to the same live session.
    const prompt = invoke(env, "cmux_pi_prompt", { workspaceId, surfaceId, message: "hello" });
    assert.equal(prompt.ok, true, prompt.error);
    assert.equal(prompt.value.sessionId, freshSessionId);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("surface-targeted ops resolve even WITHOUT surfaceId when only one row is live", async () => {
  const freshSessionId = "019e4aeb-bfd3-7cb8-82c3-9b8c799f4c6e";
  const value = await staleFixture({ freshSessionId });
  try {
    const env = { MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls, MACHINECTL_CMUX_ENV_PASSTHROUGH: "MACHINECTL_CMUX_TEST_CALLS", MACHINECTL_CMUX_PS_BIN: value.psBin };
    const tail = invoke(env, "cmux_surface_tail", { workspaceId, lines: 10 });
    assert.equal(tail.ok, true, tail.error);
    assert.equal(tail.value.sessionId, freshSessionId);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("explicit sessionId selects that live session directly", async () => {
  const freshSessionId = "019e4aeb-bfd3-7cb8-82c3-9b8c799f4c6e";
  const value = await staleFixture({ freshSessionId });
  try {
    const env = { MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls, MACHINECTL_CMUX_ENV_PASSTHROUGH: "MACHINECTL_CMUX_TEST_CALLS", MACHINECTL_CMUX_PS_BIN: value.psBin };
    const tail = invoke(env, "cmux_surface_tail", { workspaceId, surfaceId, sessionId: freshSessionId, lines: 10 });
    assert.equal(tail.ok, true, tail.error);
    assert.equal(tail.value.sessionId, freshSessionId);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("an explicit sessionId pointing only at stale rows fails closed (never targets a dead session)", async () => {
  const freshSessionId = "019e4aeb-bfd3-7cb8-82c3-9b8c799f4c6e";
  const value = await staleFixture({ freshSessionId });
  try {
    const env = { MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls, MACHINECTL_CMUX_ENV_PASSTHROUGH: "MACHINECTL_CMUX_TEST_CALLS", MACHINECTL_CMUX_PS_BIN: value.psBin };
    const tail = invoke(env, "cmux_surface_tail", { workspaceId, surfaceId, sessionId: "dead0000-0000-4000-8000-000000000000", lines: 10 });
    assert.equal(tail.ok, false);
    assert.match(tail.error, /no longer live/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
