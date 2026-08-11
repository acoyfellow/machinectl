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
  assert.deepEqual(keyboard.safe, { action: "key" });
  assert.doesNotMatch(JSON.stringify(keyboard), /return|command|do not store this/);
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
  const ax = summarizeArgs("accessibility_action", { op: "setValue", elementId: "abc", value: "secret" });
  assert.deepEqual(ax.safe, { op: "setValue", elementId: "abc" });
  assert.doesNotMatch(JSON.stringify(ax), /secret/);
});

test("catalog validation rejects malformed and excessive tool publications", () => {
  assert.equal(validateTools([{ name: "shell", description: "x", inputSchema: { type: "object" } }]), true);
  assert.equal(validateTools([{ name: "bad tool!", description: "x", inputSchema: { type: "object" } }]), false);
  assert.equal(validateTools(Array.from({ length: 65 }, (_, i) => ({ name: `t${i}`, description: "x", inputSchema: { type: "object" } }))), false);
});

test("generic safe raster data URLs survive intact", () => {
  for (const mediaType of ["png", "jpeg", "webp", "gif"]) {
    const image = `data:Image/${mediaType.toUpperCase()};base64,` + "A".repeat(600_000);
    const result = sanitizeSuccessResult("screen_record", image);
    assert.deepEqual(result, { ok: true, content: image });
    assert.doesNotMatch(result.content, /truncated by relay/);
  }
});

test("generic SVG and non-raster media data URLs are refused", () => {
  for (const content of [
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/avif;base64,AAAA",
    "data:video/quicktime;base64,AAAA",
    "data:audio/mpeg;base64,AAAA",
  ]) {
    const result = sanitizeSuccessResult("screen_record", content);
    assert.equal(result.ok, false);
    assert.equal("content" in result, false);
    assert.match(result.error, /unsupported or malformed media/);
  }
});

test("oversized generic raster data is refused rather than corrupted", () => {
  const huge = "data:image/png;base64," + "A".repeat(64 * 1024 * 1024 + 1);
  const result = sanitizeSuccessResult("screen_record", huge);
  assert.equal(result.ok, false);
  assert.match(result.error, /does not decode/);
});

test("malformed safe-raster data URLs are refused", () => {
  const result = sanitizeSuccessResult("screen_record", "data:image/png;base64,not valid base64!!");
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported or malformed media/);
});

test("ordinary text is still truncated with a visible marker", () => {
  const result = sanitizeSuccessResult("shell", "x".repeat(600_000));
  assert.equal(result.ok, true);
  assert.match(result.content, /truncated by relay/);
});
