import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("aborting shell kills the entire child process group so delayed writes never land", async () => {
  process.env.MACHINECTL_ENABLE_SHELL = "1";
  const { buildToolRegistry } = await import("../dist/tools.js");
  const marker = join(tmpdir(), `machinectl-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try { unlinkSync(marker); } catch {}
  const shell = buildToolRegistry().find((t) => t.name === "shell");
  assert.ok(shell, "shell tool should be registered");
  const controller = new AbortController();
  const pending = shell.handler({ command: `sleep 2 && echo LEAKED > ${JSON.stringify(marker)}` }, controller.signal);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(() => pending, /shell cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  assert.equal(existsSync(marker), false, "cancelled shell must kill its child sleep before it writes");
});
