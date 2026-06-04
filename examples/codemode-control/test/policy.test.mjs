import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSuccessResult, summarizeArgs, validateTools } from "../dist/test/policy.js";

test("receipts redact shell commands and harness prompts", () => {
  const shell = summarizeArgs("shell", { command: "cat ~/.ssh/id_rsa", cwd: "/work", timeoutMs: 1000 });
  assert.deepEqual(shell.safe, { cwd: "/work", timeoutMs: 1000 });
  assert.doesNotMatch(JSON.stringify(shell), /id_rsa/);
  const harness = summarizeArgs("harness_start", { harnessId: "pi", cwd: "/work", prompt: "token secret" });
  assert.deepEqual(harness.safe, { harnessId: "pi", cwd: "/work" });
  assert.doesNotMatch(JSON.stringify(harness), /token secret/);
  const keyboard = summarizeArgs("keyboard", { action: "key", key: "return", modifiers: ["command"], text: "do not store this" });
  assert.deepEqual(keyboard.safe, { action: "key", key: "return", modifiers: ["command"] });
  assert.doesNotMatch(JSON.stringify(keyboard), /do not store this/);
});

test("ordinary outputs are bounded", () => {
  const result = sanitizeSuccessResult("shell", "x".repeat(600_000));
  assert.equal(result.ok, true);
  assert.match(result.content, /truncated by relay/);
});

test("screenshots are returned intact only when valid and bounded", () => {
  const png = "data:image/png;base64," + "AAAA";
  assert.deepEqual(sanitizeSuccessResult("screenshot", png), { ok: true, content: png });
  assert.deepEqual(sanitizeSuccessResult("screenshot", "not an image"), { ok: false, error: "invalid screenshot response" });
  const huge = "data:image/png;base64," + "A".repeat(13 * 1024 * 1024);
  assert.deepEqual(sanitizeSuccessResult("screenshot", huge), { ok: false, error: "screenshot response exceeds relay limit" });
});

test("screenshot optimization metadata is auditable while batched text is redacted", () => {
  assert.deepEqual(summarizeArgs("screenshot", { format: "jpeg", quality: 60, maxWidth: 1280 }).safe, { format: "jpeg", quality: 60, maxWidth: 1280 });
  const batched = summarizeArgs("input_sequence", { actions: [{ action: "type", text: "secret" }] });
  assert.deepEqual(batched.safe, {});
  assert.doesNotMatch(JSON.stringify(batched), /secret/);
});

test("catalog validation rejects malformed and excessive tool publications", () => {
  assert.equal(validateTools([{ name: "shell", description: "x", inputSchema: { type: "object" } }]), true);
  assert.equal(validateTools([{ name: "bad tool!", description: "x", inputSchema: {} }]), false);
  assert.equal(validateTools(Array.from({ length: 65 }, (_, i) => ({ name: `t${i}`, description: "x", inputSchema: {} }))), false);
});
