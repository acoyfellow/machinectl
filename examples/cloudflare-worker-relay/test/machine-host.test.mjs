import assert from "node:assert/strict";
import test from "node:test";
import { summarizeArgs, safeText, validateTools } from "../dist/receipt-policy.js";

test("receipt summary never stores shell command content", () => {
  const summary = summarizeArgs("shell", { command: "cat ~/.ssh/id_rsa", cwd: "/Users/me/app", timeoutMs: 1000 });
  assert.deepEqual(summary.safe, { cwd: "/Users/me/app", timeoutMs: 1000 });
  assert.equal(summary.contentRedacted, true);
  assert.ok(summary.keys.includes("command"));
  assert.doesNotMatch(JSON.stringify(summary), /id_rsa/);
});

test("receipt summary redacts prompt content while preserving low-risk harness metadata", () => {
  const start = summarizeArgs("harness_start", { harnessId: "pi", cwd: "/Users/me/app", prompt: "secret prompt", model: "x" });
  assert.deepEqual(start.safe, { harnessId: "pi", cwd: "/Users/me/app", model: "x" });
  assert.doesNotMatch(JSON.stringify(start), /secret prompt/);
  const control = summarizeArgs("harness_control", { harnessId: "pi", id: "abc", command: "get_state", args: { token: "secret" } });
  assert.deepEqual(control.safe, { harnessId: "pi", id: "abc", command: "get_state" });
  assert.doesNotMatch(JSON.stringify(control), /secret/);
});

test("receipt summary exposes screenshot tuning but redacts batched input text", () => {
  const screenshot = summarizeArgs("screenshot", { format: "jpeg", quality: 60, maxWidth: 1280, fullResolution: false });
  assert.deepEqual(screenshot.safe, { format: "jpeg", quality: 60, maxWidth: 1280, fullResolution: false });
  const sequence = summarizeArgs("input_sequence", { actions: [{ action: "type", text: "secret" }] });
  assert.deepEqual(sequence.safe, {});
  assert.equal(sequence.contentRedacted, true);
  assert.doesNotMatch(JSON.stringify(sequence), /secret/);
  const ax = summarizeArgs("accessibility_action", { op: "setValue", elementId: "abc", value: "secret" });
  assert.deepEqual(ax.safe, { op: "setValue", elementId: "abc" });
  assert.doesNotMatch(JSON.stringify(ax), /secret/);
});

test("tool catalogs are bounded and validate schema-bearing entries", () => {
  assert.equal(validateTools([{ name: "shell", description: "run", inputSchema: { type: "object" } }]), true);
  assert.equal(validateTools([{ name: "bad name!", description: "run", inputSchema: { type: "object" } }]), false);
  assert.equal(validateTools(Array.from({ length: 65 }, (_, index) => ({ name: `t${index}`, description: "x", inputSchema: {} }))), false);
});

test("result text is capped before relaying", () => {
  const result = safeText("abcdefgh", 4);
  assert.match(result, /^abcd/);
  assert.match(result, /truncated by relay/);
});
