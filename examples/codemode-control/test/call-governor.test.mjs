import { test } from "node:test";
import assert from "node:assert/strict";
import { CallGovernor, catalogHash } from "../dist/test/call-governor.js";

test("the call budget is enforced within one execution", async () => {
  const governor = new CallGovernor({ maxCalls: 3, perCallTimeoutMs: 1000 });
  for (let i = 0; i < 3; i += 1) assert.equal(await governor.run("shell", async () => "ok"), "ok");
  await assert.rejects(() => governor.run("shell", async () => "ok"), /call budget of 3/);
  assert.deepEqual(governor.metrics, { calls: 3, rejected: 1 });
});

test("an unbounded guest loop cannot exceed the budget", async () => {
  const governor = new CallGovernor({ maxCalls: 10, perCallTimeoutMs: 1000 });
  let executed = 0;
  const attempts = [];
  for (let i = 0; i < 50; i += 1) {
    attempts.push(governor.run("shell", async () => { executed += 1; }).catch(() => undefined));
  }
  await Promise.all(attempts);
  assert.equal(executed, 10, "only the budgeted calls may reach upstream");
  assert.equal(governor.metrics.rejected, 40);
});

test("calls are serialized so upstream state stays coherent", async () => {
  const governor = new CallGovernor({ maxCalls: 20, perCallTimeoutMs: 2000 });
  const order = [];
  let concurrent = 0;
  let peak = 0;
  const work = (id) => governor.run("accessibility_query", async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(id);
    concurrent -= 1;
  });
  await Promise.all([work(1), work(2), work(3), work(4)]);
  assert.equal(peak, 1, "no two upstream calls may overlap");
  assert.deepEqual(order, [1, 2, 3, 4], "issue order is preserved");
});

test("a failed call does not wedge the queue", async () => {
  const governor = new CallGovernor({ maxCalls: 10, perCallTimeoutMs: 1000 });
  await assert.rejects(() => governor.run("shell", async () => { throw new Error("upstream exploded"); }), /upstream exploded/);
  assert.equal(await governor.run("shell", async () => "still works"), "still works");
});

test("a hung call is abandoned at the per-call deadline", async () => {
  const governor = new CallGovernor({ maxCalls: 10, perCallTimeoutMs: 40 });
  await assert.rejects(() => governor.run("screenshot", () => new Promise(() => {})), /exceeded 40ms/);
  assert.equal(await governor.run("shell", async () => "recovered"), "recovered");
});

test("the catalog hash is stable, order independent, and change sensitive", async () => {
  const a = await catalogHash(["shell", "screenshot", "mouse"]);
  const b = await catalogHash(["mouse", "shell", "screenshot"]);
  const c = await catalogHash(["shell", "screenshot"]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});
