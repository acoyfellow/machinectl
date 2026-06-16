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
    const result = invoke({ MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls }, "cmux_workspace_list", {});
    assert.equal(result.ok, true);
    assert.ok(result.names.includes("cmux_pi_prompt"));
    assert.equal(result.value.workspaces[0].id, workspaceId);
    assert.equal(result.value.workspaces[0].piSessions[0].surfaceId, surfaceId);
    assert.equal(result.value.workspaces[0].piSessions[0].lastAssistantText, "done");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("cmux adapter rejects stale workspace IDs before mutation", async () => {
  const value = await fixture();
  try {
    const result = invoke({ MACHINECTL_ENABLE_CMUX: "1", MACHINECTL_CMUX_BIN: value.binary, MACHINECTL_CMUX_PI_SESSION_STORE: value.store, MACHINECTL_CMUX_TEST_CALLS: value.calls }, "cmux_workspace_focus", { workspaceId: "99999999-9999-4999-8999-999999999999" });
    assert.equal(result.ok, false);
    assert.match(result.error, /Unknown or stale/);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
