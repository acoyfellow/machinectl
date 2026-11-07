import assert from "node:assert/strict";
import test from "node:test";
import { OpLedger } from "../dist/op-ledger.js";

test("a resent opId while the first run is in flight joins it and runs the tool once", async () => {
  const ledger = new OpLedger();
  let runs = 0;
  let finish;
  const work = () => { runs++; return new Promise((resolve) => { finish = resolve; }); };
  const first = ledger.run("op-1", work);
  const resend = ledger.run("op-1", work);
  assert.equal(resend.replayed, true);
  finish({ ok: true, content: "done" });
  assert.deepEqual(await first.promise, { ok: true, content: "done" });
  assert.deepEqual(await resend.promise, { ok: true, content: "done" });
  assert.equal(runs, 1);
});

test("a resent opId after the run finished returns the recorded result without running again", async () => {
  const ledger = new OpLedger();
  let runs = 0;
  const work = async () => { runs++; return { ok: true, content: `run ${runs}` }; };
  await ledger.run("op-2", work).promise;
  const again = ledger.run("op-2", work);
  assert.equal(again.replayed, true);
  assert.deepEqual(await again.promise, { ok: true, content: "run 1" });
  assert.equal(runs, 1);
});

test("calls without an opId always run", async () => {
  const ledger = new OpLedger();
  let runs = 0;
  const work = async () => { runs++; return { ok: true, content: "x" }; };
  await ledger.run(undefined, work).promise;
  await ledger.run(undefined, work).promise;
  assert.equal(runs, 2);
  assert.equal(ledger.size(), 0);
});

test("finished entries expire after the ttl and the ledger stays bounded", async () => {
  let clock = 0;
  const ledger = new OpLedger({ ttlMs: 1000, maxEntries: 2, now: () => clock });
  const work = async () => ({ ok: true, content: "x" });
  await ledger.run("a", work).promise;
  await ledger.run("b", work).promise;
  await ledger.run("c", work).promise;
  await ledger.run("d", work).promise;
  assert.ok(ledger.size() <= 3);
  clock = 5000;
  await ledger.run("e", work).promise;
  assert.equal(ledger.size(), 1);
});
