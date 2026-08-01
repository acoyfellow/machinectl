import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, symlink as makeSymlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function rgbaPng(red, green, blue, alpha = 255) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.from([0, red, green, blue, alpha, red, green, blue, alpha]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat([row, row]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("default registry exposes core controls without optional harness tools", () => {
  assert.deepEqual(parseRun(coreSource), ["shell", "screenshot", "screen_record", "mouse", "keyboard", "input_sequence", "accessibility_query", "accessibility_action", "local_auth_status"]);
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

test("screenshot schema defaults to compressed preview, accepts ratio quality, and preserves explicit PNG", () => {
  const source = `import { buildToolRegistry } from './dist/tools.js'; const t = buildToolRegistry().find(tool => tool.name === 'screenshot'); console.log(JSON.stringify({ preview: t.validator.parse({}), ratio: t.validator.parse({ quality: 0.7 }), exact: t.validator.parse({ format: 'png', fullResolution: true }) }));`;
  const values = parseRun(source);
  assert.equal(values.preview.format, "jpeg");
  assert.equal(values.preview.fullResolution, false);
  assert.equal(values.ratio.quality, 70);
  assert.equal(values.exact.format, "png");
  assert.equal(values.exact.fullResolution, true);
});

test("screen_record publishes a bounded default recording schema", () => {
  const source = `import { buildToolRegistry } from './dist/tools.js'; const t = buildToolRegistry().find(tool => tool.name === 'screen_record'); console.log(JSON.stringify(t.validator.parse({})));`;
  const values = parseRun(source);
  assert.equal(values.durationSec, 3);
  assert.equal(values.showClicks, false);
  assert.equal(values.captureAudio, false);
});

test("input_sequence batches actions while preserving existing input primitives", () => {
  const tools = parseRun(coreSource);
  assert.ok(tools.includes("mouse"));
  assert.ok(tools.includes("keyboard"));
  assert.ok(tools.includes("input_sequence"));
  assert.ok(tools.includes("accessibility_query"));
  assert.ok(tools.includes("accessibility_action"));
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

// ── screen_record lock/hang hardening (darwin-only handler) ────────────────
// These reproduce the BUG REPORT: video capture stalls at the locked
// loginwindow while the run wrapper lacked a bounded timeout, leaking orphan
// screencapture processes. We inject a fake capture binary and a fake lock
// probe (both test-only env seams) so the behavior is deterministic without a
// real locked session.

const darwinOnly = process.platform === "darwin" ? test : test.skip;

// A fake "screencapture" that hangs forever, writing its own PID to $PIDFILE
// so the test can assert the child is reaped (no orphan) after the bounded
// timeout. It ignores TERM to prove the KILL escalation reaps a stubborn child.
const HANGING_CAPTURE = `#!/bin/bash
echo $$ > "$PIDFILE"
trap '' TERM
while true; do sleep 1; done
`;

// A fake "screencapture" that writes a tiny valid-enough .mov to the last arg.
const WORKING_CAPTURE = `#!/bin/bash
out="\${@: -1}"
printf 'MOOV-FAKE-VIDEO' > "$out"
exit 0
`;

async function writeFakeBin(dir, name, body) {
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
  return path;
}

const COPYING_SCREENSHOT_CAPTURE = `#!/bin/bash
out="\${@: -1}"
cp "$SCREENSHOT_FIXTURE" "$out"
`;

darwinOnly("screenshot rejects an all-black frame before returning image data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machinectl-black-frame-"));
  try {
    const fixture = join(dir, "black.png");
    await writeFile(fixture, rgbaPng(0, 0, 0));
    const capture = await writeFakeBin(dir, "screencapture", COPYING_SCREENSHOT_CAPTURE);
    const result = parseRun(invokeSource("screenshot", { format: "png", fullResolution: true }), {
      MACHINECTL_SCREEN_LOCK_PROBE: 'printf "<key>CGSSessionScreenIsLocked</key><false/>"',
      MACHINECTL_SCREENSHOT_BIN: capture,
      SCREENSHOT_FIXTURE: fixture,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /all-black frame|Screen Recording access/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

darwinOnly("screenshot returns a deterministic non-black PNG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machinectl-visible-frame-"));
  try {
    const fixture = join(dir, "visible.png");
    const expected = rgbaPng(245, 92, 66);
    await writeFile(fixture, expected);
    const capture = await writeFakeBin(dir, "screencapture", COPYING_SCREENSHOT_CAPTURE);
    const result = parseRun(invokeSource("screenshot", { format: "png", fullResolution: true }), {
      MACHINECTL_SCREEN_LOCK_PROBE: 'printf "<key>CGSSessionScreenIsLocked</key><false/>"',
      MACHINECTL_SCREENSHOT_BIN: capture,
      SCREENSHOT_FIXTURE: fixture,
    });
    assert.equal(result.ok, true);
    assert.match(result.value, /^data:image\/png;base64,/);
    assert.deepEqual(Buffer.from(result.value.split(",")[1], "base64"), expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

darwinOnly("screen_record fails fast and spawns nothing while the screen is locked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machinectl-lock-"));
  try {
    const capture = await writeFakeBin(dir, "screencapture", HANGING_CAPTURE);
    const result = parseRun(invokeSource("screen_record", { durationSec: 3 }), {
      // Lock probe reports LOCKED; capture bin points at the hanging fake so we
      // can prove it is never invoked (a hang would blow the 15s harness cap).
      MACHINECTL_SCREEN_LOCK_PROBE: 'printf "<key>CGSSessionScreenIsLocked</key><true/>"',
      MACHINECTL_SCREENCAPTURE_BIN: capture,
    });
    assert.equal(result.ok, false, "locked capture must fail");
    assert.match(result.error, /locked/i, "error must clearly state the machine is locked");
    assert.doesNotMatch(result.error, /timed out/i, "must fail fast at preflight, not by timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

darwinOnly("screen_record bounds a hung capture, terminates it, and leaves no orphan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machinectl-hang-"));
  const pidFile = join(dir, "capture.pid");
  try {
    const capture = await writeFakeBin(dir, "screencapture", HANGING_CAPTURE);
    const started = Date.now();
    const output = runIsolated(invokeSource("screen_record", { durationSec: 1 }), {
      // Unlocked, but the capture binary hangs forever. Bound = 1s + grace.
      MACHINECTL_SCREEN_LOCK_PROBE: 'printf "<key>CGSSessionScreenIsLocked</key><false/>"',
      MACHINECTL_SCREENCAPTURE_BIN: capture,
      MACHINECTL_SCREEN_RECORD_GRACE_MS: "1000",
      PIDFILE: pidFile,
    });
    const elapsed = Date.now() - started;
    const result = JSON.parse(output);
    assert.equal(result.ok, false, "a hung capture must surface an error, not hang");
    assert.match(result.error, /timed out|terminated/i, "error must explain the bounded termination");
    // 1s duration + 1s grace + <=1.5s kill grace: comfortably under the 15s cap.
    assert.ok(elapsed < 12_000, `must return promptly after the bound, took ${elapsed}ms`);
    // The fake wrote its PID; verify that process was reaped (no orphan).
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(pid) && pid > 0, "fake capture should have recorded its pid");
    // Give the KILL escalation a moment to land, then confirm the child is gone.
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(pidAlive(pid), false, `orphan screencapture pid ${pid} must not remain alive`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

darwinOnly("screen_record returns a video data URL on a successful unlocked capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machinectl-ok-"));
  try {
    const capture = await writeFakeBin(dir, "screencapture", WORKING_CAPTURE);
    const result = parseRun(invokeSource("screen_record", { durationSec: 1 }), {
      MACHINECTL_SCREEN_LOCK_PROBE: 'printf "<key>CGSSessionScreenIsLocked</key><false/>"',
      MACHINECTL_SCREENCAPTURE_BIN: capture,
    });
    assert.equal(result.ok, true, "unlocked capture with output must succeed");
    assert.match(result.value, /^data:video\/quicktime;base64,/, "must return a quicktime data URL");
    const b64 = result.value.split(",")[1];
    assert.equal(Buffer.from(b64, "base64").toString("utf8"), "MOOV-FAKE-VIDEO", "payload must be the captured bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

darwinOnly("screen_record reports a clear error when capture produces no file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "machinectl-empty-"));
  try {
    // Exits 0 but writes nothing — the classic "hang produced no .mov" tail case.
    const capture = await writeFakeBin(dir, "screencapture", "#!/bin/bash\nexit 0\n");
    const result = parseRun(invokeSource("screen_record", { durationSec: 1 }), {
      MACHINECTL_SCREEN_LOCK_PROBE: 'printf "<key>CGSSessionScreenIsLocked</key><false/>"',
      MACHINECTL_SCREENCAPTURE_BIN: capture,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no output file|empty/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
