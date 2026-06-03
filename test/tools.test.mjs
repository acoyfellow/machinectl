import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, symlink as makeSymlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runIsolated(source, env = {}) {
  return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
}

const coreSource = `import { buildToolRegistry } from './dist/tools.js'; console.log(JSON.stringify(buildToolRegistry().map(t => t.name)));`;
const invokeSource = (name, args) => `import { buildToolRegistry } from './dist/tools.js'; const tool = buildToolRegistry().find(t => t.name === ${JSON.stringify(name)}); try { console.log(JSON.stringify({ ok: true, value: await tool.handler(${JSON.stringify(args)}) })); } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); }`;

function parseRun(source, env) { return JSON.parse(runIsolated(source, env)); }

test("default registry exposes core controls without optional harness tools", () => {
  assert.deepEqual(parseRun(coreSource), ["shell", "screenshot", "mouse", "keyboard", "local_auth_status"]);
});

test("shell validates explicit cwd roots and does not claim shell sandboxing", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "machinectl-allowed-"));
  const outside = await mkdtemp(join(tmpdir(), "machinectl-outside-"));
  try {
    const success = parseRun(invokeSource("shell", { command: "pwd", cwd: allowed, timeoutMs: 1000 }), { MACHINECTL_ALLOWED_PATHS: allowed });
    assert.equal(success.ok, true);
    assert.match(success.value, /Exit code: 0/);
    assert.match(success.value, new RegExp(await realpath(allowed)));
    const denied = parseRun(invokeSource("shell", { command: "pwd", cwd: outside, timeoutMs: 1000 }), { MACHINECTL_ALLOWED_PATHS: allowed });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /outside MACHINECTL_ALLOWED_PATHS/);
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("shell rejects a symlink cwd escape", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "machinectl-root-"));
  const outside = await mkdtemp(join(tmpdir(), "machinectl-escape-"));
  const link = join(allowed, "escape");
  try {
    await makeSymlink(outside, link);
    const denied = parseRun(invokeSource("shell", { command: "pwd", cwd: link, timeoutMs: 1000 }), { MACHINECTL_ALLOWED_PATHS: allowed });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /outside MACHINECTL_ALLOWED_PATHS/);
  } finally {
    await rm(allowed, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("local auth projection contains only allowlisted bounded diagnostic fields", () => {
  const source = `import { projectLocalAuthStatus } from './dist/tools.js'; console.log(projectLocalAuthStatus({ version: '0.1.0', checkedAt: 'now', secret: 'DO_NOT_LEAK', resources: [{ id: 'my-ax', label: 'my ax', kind: 'cloudflared-access', state: 'valid', expiresAt: 'soon', token: 'DO_NOT_LEAK_TOKEN', recovery: { command: 'danger' } }] }));`;
  const output = runIsolated(source);
  const projected = JSON.parse(output);
  assert.equal(projected.version, "0.1.0");
  assert.deepEqual(projected.resources[0], { id: "my-ax", label: "my ax", kind: "cloudflared-access", state: "valid", expiresAt: "soon" });
  assert.doesNotMatch(output, /DO_NOT_LEAK|danger|token|recovery/);
  assert.ok(Buffer.byteLength(output) < 16 * 1024);
});

test("enabled adapters publish honest harness capabilities", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "machinectl-harness-"));
  try {
    const source = `import { buildToolRegistry } from './dist/tools.js'; const tools = buildToolRegistry(); const catalog = tools.find(t => t.name === 'harness_catalog'); console.log(JSON.stringify({ names: tools.map(t => t.name), catalog: JSON.parse(await catalog.handler({})) }));`;
    const result = parseRun(source, { MACHINECTL_ALLOWED_PATHS: cwd, MACHINECTL_ENABLE_PI: "1" });
    const pi = result.catalog.harnesses.find((harness) => harness.id === "pi");
    assert.deepEqual(result.catalog.harnesses.map((harness) => harness.id), ["pi"]);
    assert.ok(pi.capabilities.includes("steer"));
    assert.ok(result.names.includes("pi_start"), "pi compatibility tools remain published");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
