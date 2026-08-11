import assert from "node:assert/strict";
import test from "node:test";
import { assertDeployableConfig, verifyAccess } from "../dist/test/auth.js";

const LOOPBACK = "http://127.0.0.1:8789/api/status";
const PUBLIC = "https://machinectl.example.com/api/status";

function devEnv(extra = {}) {
  return { MACHINECTL_ENV: "development", MACHINECTL_DEV_AUTH: "1", ...extra };
}

test("the development bypass works only on a loopback host", async () => {
  const identity = await verifyAccess(new Request(LOOPBACK), devEnv());
  assert.equal(identity.email, "dev@machinectl.local");
  await assert.rejects(() => verifyAccess(new Request(PUBLIC), devEnv()), /non-loopback host/);
});

test("the development bypass refuses to run outside a development configuration", async () => {
  await assert.rejects(
    () => verifyAccess(new Request(LOOPBACK), { MACHINECTL_DEV_AUTH: "1", MACHINECTL_ENV: "production" }),
    /outside local development/,
  );
});

test("a bypass configuration is refused when it carries real Access settings", () => {
  assert.throws(
    () => assertDeployableConfig(devEnv({ CF_ACCESS_ISS: "https://team.cloudflareaccess.com", CF_ACCESS_AUD: "aud" })),
    /MACHINECTL_DEV_AUTH/,
    "a config holding both a bypass and real Access credentials is a deploy accident",
  );
});

test("a bypass configuration is refused when a deployment environment is declared", () => {
  assert.throws(() => assertDeployableConfig(devEnv({ MACHINECTL_ENV: "production" })), /MACHINECTL_DEV_AUTH/);
  assert.throws(() => assertDeployableConfig({ MACHINECTL_DEV_AUTH: "1" }), /MACHINECTL_ENV/);
});

test("an ordinary development configuration passes", () => {
  assert.doesNotThrow(() => assertDeployableConfig(devEnv()));
});

test("an ordinary production configuration passes", () => {
  assert.doesNotThrow(() => assertDeployableConfig({
    MACHINECTL_ENV: "production",
    CF_ACCESS_ISS: "https://team.cloudflareaccess.com",
    CF_ACCESS_AUD: "aud",
    MACHINECTL_ALLOWED_EMAILS: "operator@example.com",
  }));
});

test("a real Access path requires an explicit operator allowlist", async () => {
  await assert.rejects(
    () => verifyAccess(new Request(PUBLIC), { CF_ACCESS_ISS: "https://team.cloudflareaccess.com", CF_ACCESS_AUD: "aud" }),
    /Missing Cloudflare Access JWT assertion/,
  );
});
