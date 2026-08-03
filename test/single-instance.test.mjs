import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
  acquireInstanceLock,
  instanceLockPath,
  InstanceLockedError,
} = await import("../dist/single-instance.js");

async function withStateDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "mc-lock-"));
  const previous = process.env.MACHINECTL_STATE_DIR;
  process.env.MACHINECTL_STATE_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.MACHINECTL_STATE_DIR;
    else process.env.MACHINECTL_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function seedLock(path, holder) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, typeof holder === "string" ? holder : JSON.stringify(holder) + "\n");
}

function waitForFile(path, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`file did not appear: ${path}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("a lock records the holder and the release removes the file", async () => {
  await withStateDir(async () => {
    const lock = acquireInstanceLock("jcoeyman-macbook", "https://my.ax.cloudflare.dev");
    const holder = JSON.parse(readFileSync(lock.path, "utf-8"));
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.name, "jcoeyman-macbook");
    assert.equal(holder.url, "https://my.ax.cloudflare.dev");
    lock.release();
    assert.equal(existsSync(lock.path), false);
  });
});

test("a live holder blocks a second daemon with the same identity", async () => {
  await withStateDir(async () => {
    const path = instanceLockPath("jcoeyman-macbook", "https://my.ax.cloudflare.dev");
    const rival = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      seedLock(path, { pid: rival.pid, name: "jcoeyman-macbook", url: "https://my.ax.cloudflare.dev", startedAt: new Date().toISOString() });
      assert.throws(
        () => acquireInstanceLock("jcoeyman-macbook", "https://my.ax.cloudflare.dev"),
        (err) => err instanceof InstanceLockedError
          && /already controls the identity/.test(err.message)
          && err.holder.pid === rival.pid,
      );
      assert.equal(JSON.parse(readFileSync(path, "utf-8")).pid, rival.pid);
    } finally {
      rival.kill("SIGKILL");
    }
  });
});

test("a lock from a dead process is reclaimed", async () => {
  await withStateDir(async () => {
    const path = instanceLockPath("jcoeyman-macbook", "https://my.ax.cloudflare.dev");
    seedLock(path, { pid: 999_999_998, name: "jcoeyman-macbook", url: "https://my.ax.cloudflare.dev", startedAt: new Date().toISOString() });
    const lock = acquireInstanceLock("jcoeyman-macbook", "https://my.ax.cloudflare.dev");
    assert.equal(JSON.parse(readFileSync(lock.path, "utf-8")).pid, process.pid);
    lock.release();
  });
});

test("a damaged lock file does not stop a daemon", async () => {
  await withStateDir(async () => {
    const path = instanceLockPath("jcoeyman-macbook", "https://my.ax.cloudflare.dev");
    seedLock(path, "this is not json\n");
    const lock = acquireInstanceLock("jcoeyman-macbook", "https://my.ax.cloudflare.dev");
    assert.equal(JSON.parse(readFileSync(lock.path, "utf-8")).pid, process.pid);
    lock.release();
  });
});

test("a different name and a different relay each get a separate lock", async () => {
  await withStateDir(async () => {
    const prod = acquireInstanceLock("jcoeyman-macbook", "https://my.ax.cloudflare.dev");
    const otherName = acquireInstanceLock("local-mac", "https://my.ax.cloudflare.dev");
    const otherRelay = acquireInstanceLock("jcoeyman-macbook", "http://127.0.0.1:8789");
    assert.equal(new Set([prod.path, otherName.path, otherRelay.path]).size, 3);
    prod.release();
    otherName.release();
    otherRelay.release();
  });
});

test("a release does not remove a lock that another process owns", async () => {
  await withStateDir(async () => {
    const lock = acquireInstanceLock("jcoeyman-macbook", "https://my.ax.cloudflare.dev");
    writeFileSync(lock.path, JSON.stringify({
      pid: process.pid + 1,
      name: "jcoeyman-macbook",
      url: "https://my.ax.cloudflare.dev",
      startedAt: new Date().toISOString(),
    }) + "\n");
    lock.release();
    assert.equal(existsSync(lock.path), true);
  });
});

test("a second real daemon with one identity refuses to start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mc-lock-e2e-"));
  const env = {
    ...process.env,
    MACHINECTL_STATE_DIR: dir,
    MACHINECTL_NAME: "duplicate-identity-test",
    MACHINECTL_URL: "http://127.0.0.1:9",
    MACHINECTL_ACCESS_TOKEN: "dev",
    MACHINECTL_ALLOWED_PATHS: dir,
    MACHINECTL_LOG_TIMING: "",
  };
  const first = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const lockPath = join(dir, "machinectl", "locks");
    await waitForFile(lockPath);
    let stderr = "";
    const second = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
    second.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    const code = await new Promise((resolve) => second.on("close", resolve));
    assert.equal(code, 1);
    assert.match(stderr, /already controls the identity "duplicate-identity-test"/);
    assert.match(stderr, /remove each other from the relay/);
    assert.equal(first.exitCode, null);
  } finally {
    first.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
