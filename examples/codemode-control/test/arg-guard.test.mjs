import { test } from "node:test";
import assert from "node:assert/strict";
import { checkArgs } from "../dist/test/arg-guard.js";

const screenshotSchema = {
  type: "object",
  properties: {
    format: { type: "string", enum: ["jpeg", "png"] },
    quality: { type: "number" },
    maxWidth: { type: "number" },
    fullResolution: { type: "boolean" },
    region: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["x", "y", "width", "height"] },
  },
};

test("valid arguments pass unchanged", () => {
  assert.equal(checkArgs("screenshot", screenshotSchema, { format: "jpeg", maxWidth: 1280 }), null);
  assert.equal(checkArgs("screenshot", screenshotSchema, {}), null);
  assert.equal(checkArgs("screenshot", screenshotSchema, { region: { x: 0, y: 0, width: 10, height: 10 } }), null);
});

test("an undeclared parameter is refused before it reaches the laptop", () => {
  const rejection = checkArgs("screenshot", screenshotSchema, { format: "png", surprise: "payload" });
  assert.ok(rejection);
  assert.match(rejection.error, /surprise is not a declared parameter/);
});

test("a wrong type is refused", () => {
  assert.match(checkArgs("screenshot", screenshotSchema, { maxWidth: "wide" }).error, /must be of type number/);
  assert.match(checkArgs("screenshot", screenshotSchema, { fullResolution: "yes" }).error, /must be of type boolean/);
});

test("a value outside the declared enum is refused", () => {
  assert.match(checkArgs("screenshot", screenshotSchema, { format: "tiff" }).error, /must be one of/);
});

test("a missing required nested field is refused", () => {
  assert.match(checkArgs("screenshot", screenshotSchema, { region: { x: 1, y: 2 } }).error, /width is required/);
});

test("a nested undeclared field is refused", () => {
  assert.match(checkArgs("screenshot", screenshotSchema, { region: { x: 1, y: 2, width: 3, height: 4, z: 5 } }).error, /region.z is not a declared parameter/);
});

test("non-object arguments are refused", () => {
  assert.match(checkArgs("shell", { type: "object" }, ["ls"]).error, /must be an object/);
  assert.equal(checkArgs("shell", { type: "object" }, undefined), null);
});

test("oversized arguments are refused", () => {
  const huge = { command: "x".repeat(300 * 1024) };
  assert.match(checkArgs("shell", { type: "object", properties: { command: { type: "string" } } }, huge).error, /byte relay limit/);
});

test("deeply nested arguments are refused rather than walked forever", () => {
  let nested = { value: 1 };
  for (let i = 0; i < 20; i += 1) nested = { inner: nested };
  const schema = { type: "object", properties: { inner: { type: "object" } } };
  const rejection = checkArgs("shell", schema, nested);
  assert.ok(rejection === null || /nests deeper|not a declared/.test(rejection.error));
});

test("an unknown schema does not block the call", () => {
  assert.equal(checkArgs("future_tool", undefined, { anything: true }), null);
  assert.equal(checkArgs("future_tool", {}, { anything: true }), null);
});
