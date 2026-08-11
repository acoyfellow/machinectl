import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runIsolated(source, env = {}) {
  return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, MACHINECTL_LOG_TIMING: "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

const registryNames = `
  const { buildToolRegistry } = await import("./dist/tools.js");
  console.log(JSON.stringify(buildToolRegistry().map((tool) => tool.name)));
`;

function shellCall(command, cwd) {
  const args = JSON.stringify(cwd ? { command, cwd } : { command });
  return `
    const { buildToolRegistry } = await import("./dist/tools.js");
    const shell = buildToolRegistry().find((tool) => tool.name === "shell");
    if (!shell) { console.log(JSON.stringify({ absent: true })); }
    else {
      try { console.log(JSON.stringify({ ok: await shell.handler(${args}) })); }
      catch (error) { console.log(JSON.stringify({ error: String(error.message ?? error) })); }
    }
  `;
}

test("shell is absent unless it is explicitly enabled", () => {
  const names = JSON.parse(runIsolated(registryNames, { MACHINECTL_ENABLE_SHELL: "" }));
  assert.equal(names.includes("shell"), false, "terminal-equivalent capability must be opt-in");
});

test("shell appears once enabled", () => {
  const names = JSON.parse(runIsolated(registryNames, { MACHINECTL_ENABLE_SHELL: "1" }));
  assert.equal(names.includes("shell"), true);
});

test("a command with no cwd still runs inside the allowed root", async () => {
  const root = await mkdtemp(join(tmpdir(), "machinectl-root-"));
  try {
    const result = JSON.parse(runIsolated(shellCall("pwd"), {
      MACHINECTL_ENABLE_SHELL: "1",
      MACHINECTL_ALLOWED_PATHS: root,
    }));
    assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
    assert.match(result.ok, /machinectl-root-/, "an omitted cwd must default into the allowed root, not the daemon directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cwd outside the allowed root is still refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "machinectl-root-"));
  try {
    const result = JSON.parse(runIsolated(shellCall("pwd", "/"), {
      MACHINECTL_ENABLE_SHELL: "1",
      MACHINECTL_ALLOWED_PATHS: root,
    }));
    assert.match(result.error ?? "", /outside MACHINECTL_ALLOWED_PATHS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a shell command cannot read the daemon's own secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "machinectl-root-"));
  try {
    const result = JSON.parse(runIsolated(shellCall("echo \"[$MACHINECTL_ACCESS_TOKEN][$AWS_SECRET_ACCESS_KEY]\""), {
      MACHINECTL_ENABLE_SHELL: "1",
      MACHINECTL_ALLOWED_PATHS: root,
      MACHINECTL_ACCESS_TOKEN: "super-secret-access-token",
      AWS_SECRET_ACCESS_KEY: "super-secret-aws-key",
    }));
    assert.ok(result.ok !== undefined, `expected output, got ${JSON.stringify(result)}`);
    assert.equal(result.ok.includes("super-secret-access-token"), false, "the Access token must not reach a shell command");
    assert.equal(result.ok.includes("super-secret-aws-key"), false, "inherited credentials must not reach a shell command");
    assert.match(result.ok, /\[\]\[\]/, "both variables must be empty in the child environment");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an operator can pass a variable through on purpose", async () => {
  const root = await mkdtemp(join(tmpdir(), "machinectl-root-"));
  try {
    const result = JSON.parse(runIsolated(shellCall("echo \"[$BUILD_CHANNEL]\""), {
      MACHINECTL_ENABLE_SHELL: "1",
      MACHINECTL_ALLOWED_PATHS: root,
      MACHINECTL_SHELL_ENV_PASSTHROUGH: "BUILD_CHANNEL",
      BUILD_CHANNEL: "beta",
    }));
    assert.match(result.ok ?? "", /\[beta\]/, "an explicit passthrough must survive the scrub");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Access token remains excluded when listed for shell passthrough", async () => {
  const root = await mkdtemp(join(tmpdir(), "machinectl-root-"));
  try {
    const result = JSON.parse(runIsolated(shellCall("echo \"[$MACHINECTL_ACCESS_TOKEN]\""), {
      MACHINECTL_ENABLE_SHELL: "1",
      MACHINECTL_ALLOWED_PATHS: root,
      MACHINECTL_SHELL_ENV_PASSTHROUGH: "MACHINECTL_ACCESS_TOKEN",
      MACHINECTL_ACCESS_TOKEN: "super-secret-access-token",
    }));
    assert.equal(result.ok.includes("super-secret-access-token"), false, "the passthrough list cannot reintroduce the Access token");
    assert.match(result.ok, /\[\]/, "the Access token must be unset in the child environment");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PATH survives the scrub so ordinary commands work", async () => {
  const root = await mkdtemp(join(tmpdir(), "machinectl-root-"));
  try {
    const result = JSON.parse(runIsolated(shellCall("git --version >/dev/null && echo resolved"), {
      MACHINECTL_ENABLE_SHELL: "1",
      MACHINECTL_ALLOWED_PATHS: root,
    }));
    assert.match(result.ok ?? "", /resolved/, "scrubbing must not break command resolution");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
