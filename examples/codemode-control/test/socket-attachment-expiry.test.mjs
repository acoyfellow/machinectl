import assert from "node:assert/strict";
import test from "node:test";
import { readSocketStorageIfUnexpired, socketAttachmentExpired } from "../dist/test/socket-expiry.js";

const now = 1_740_000_000_000;

function attachment(expiresAt) {
  return { generation: "generation", connectedAt: now - 1_000, expiresAt };
}

test("socket attachment expiry rejects missing, invalid, and elapsed expiries", () => {
  assert.equal(socketAttachmentExpired(null, now), true);
  assert.equal(socketAttachmentExpired({}, now), true);
  assert.equal(socketAttachmentExpired(attachment(Number.NaN), now), true);
  assert.equal(socketAttachmentExpired(attachment(Number.POSITIVE_INFINITY), now), true);
  assert.equal(socketAttachmentExpired(attachment(now / 1_000 - 1), now), true);
  assert.equal(socketAttachmentExpired(attachment(now / 1_000), now), true);
  assert.equal(socketAttachmentExpired(attachment(now / 1_000 + 1), now), false);
});

test("storage reads reject a socket that expires while awaiting", async () => {
  let clock = now;
  let release;
  const generation = new Promise((resolve) => { release = resolve; });
  const result = readSocketStorageIfUnexpired(
    attachment(now / 1_000 + 1),
    () => generation,
    () => clock,
  );
  clock = now + 1_000;
  release("current-generation");
  assert.deepEqual(await result, { expired: true });
});
