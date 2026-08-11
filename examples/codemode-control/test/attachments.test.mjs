import { test } from "node:test";
import assert from "node:assert/strict";
import { AttachmentStore, isImageDataUrl, selectAttachmentDelivery } from "../dist/test/attachments.js";

const png = (n) => "data:image/png;base64," + "A".repeat(n);

test("an image is replaced by opaque metadata carrying no bytes", () => {
  const store = new AttachmentStore();
  const handle = store.retain(png(4096));
  assert.ok(!("error" in handle));
  assert.match(handle.attachmentId, /^att_[0-9a-f]{32}$/);
  assert.equal(handle.mediaType, "image/png");
  assert.ok(handle.byteLength > 4000);
  assert.equal(JSON.stringify(handle).includes("AAAA"), false);
});

test("attachment ids are unguessable and distinct per retain", () => {
  const store = new AttachmentStore();
  const first = store.retain(png(64));
  const second = store.retain(png(64));
  assert.notEqual(first.attachmentId, second.attachmentId);
});

test("a non-image payload is refused rather than stored", () => {
  const store = new AttachmentStore();
  const result = store.retain("data:text/html;base64,PGh0bWw+");
  assert.ok("error" in result);
  assert.equal(store.size, 0);
});

test("the item count limit is enforced within one execution", () => {
  const store = new AttachmentStore();
  for (let i = 0; i < 8; i += 1) assert.ok(!("error" in store.retain(png(64))));
  const overflow = store.retain(png(64));
  assert.ok("error" in overflow);
  assert.match(overflow.error, /count limit/);
});

test("the aggregate byte limit is enforced across calls", () => {
  const store = new AttachmentStore();
  const big = png(5 * 1024 * 1024);
  let refused = null;
  for (let i = 0; i < 8 && !refused; i += 1) {
    const outcome = store.retain(big);
    if ("error" in outcome) refused = outcome;
  }
  assert.ok(refused, "aggregate limit must refuse before the item limit is reached");
  assert.match(refused.error, /aggregate byte limit/);
});

test("only ids the guest returned are materialized", () => {
  const store = new AttachmentStore();
  const kept = store.retain(png(64));
  const dropped = store.retain(png(64));
  const referenced = store.referenced({ shot: kept.attachmentId, note: "done" });
  assert.equal(referenced.length, 1);
  assert.equal(referenced[0].id, kept.attachmentId);
  assert.ok(referenced.every((entry) => entry.id !== dropped.attachmentId));
});

test("a forged or unknown id resolves to nothing", () => {
  const store = new AttachmentStore();
  store.retain(png(64));
  assert.equal(store.referenced({ a: "att_" + "0".repeat(32) }).length, 0);
  assert.equal(store.resolve("att_deadbeef"), undefined);
  assert.equal(store.resolve(42), undefined);
});

test("reference scanning terminates on deep and cyclic results", () => {
  const store = new AttachmentStore();
  const handle = store.retain(png(64));
  const cyclic = { level: 1 };
  cyclic.self = cyclic;
  assert.equal(store.referenced(cyclic).length, 0);
  let nested = handle.attachmentId;
  for (let i = 0; i < 12; i += 1) nested = { deeper: nested };
  assert.equal(store.referenced(nested).length, 0);
});

test("data url detection accepts supported images and rejects others", () => {
  assert.equal(isImageDataUrl(png(8)), true);
  assert.equal(isImageDataUrl("data:image/svg+xml;base64,PHN2Zy8+"), false);
  assert.equal(isImageDataUrl("not a data url"), false);
});

test("the manifest lists every retained attachment without bytes", () => {
  const store = new AttachmentStore();
  const first = store.retain(png(128));
  const second = store.retain(png(256));
  const manifest = store.manifest();
  assert.equal(manifest.length, 2);
  assert.deepEqual(manifest.map((entry) => entry.attachmentId).sort(), [first.attachmentId, second.attachmentId].sort());
  assert.equal(JSON.stringify(manifest).includes("AAAA"), false);
  for (const entry of manifest) {
    assert.equal(entry.mediaType, "image/png");
    assert.ok(entry.byteLength > 0);
  }
});

test("the manifest distinguishes retained from returned attachments", () => {
  const store = new AttachmentStore();
  const kept = store.retain(png(64));
  store.retain(png(64));
  assert.equal(store.manifest().length, 2, "both were captured during the execution");
  const returned = store.referenced({ shot: kept.attachmentId });
  assert.equal(returned.length, 1, "only one was surfaced to the caller");
});

test("size-capped attachments are retained but excluded from returned audit records", () => {
  const first = { id: "att_first", mediaType: "image/png", byteLength: 7 * 1024 * 1024, dataUrl: png(4) };
  const dropped = { id: "att_dropped", mediaType: "image/png", byteLength: 7 * 1024 * 1024, dataUrl: png(4) };
  const manifest = [first, dropped].map(({ id, mediaType, byteLength }) => ({ attachmentId: id, mediaType, byteLength }));
  const delivery = selectAttachmentDelivery(manifest, [first, dropped], 12 * 1024 * 1024);
  assert.deepEqual(delivery.emitted.map((attachment) => attachment.id), [first.id]);
  assert.deepEqual(delivery.attachmentsReturned, [first.id]);
  assert.deepEqual(delivery.attachmentsRetainedUnreturned, [dropped.id]);
});
