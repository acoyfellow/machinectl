import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { hasExpiredAccess, verifyAccess } from "../dist/test/auth.js";

const LOOPBACK = "http://127.0.0.1:8789/api/status";

function devEnv() {
  return { MACHINECTL_ENV: "development", MACHINECTL_DEV_AUTH: "1" };
}

async function accessIssuer() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.alg = "RS256";
  jwk.kid = "test-key";
  jwk.use = "sig";
  const server = createServer((request, response) => {
    if (request.url !== "/cdn-cgi/access/certs") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test Access issuer did not provide a TCP address");
  return {
    issuer: `http://127.0.0.1:${address.port}`,
    privateKey,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("verifyAccess surfaces the verified Access JWT expiry", async () => {
  const issuer = await accessIssuer();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  try {
    const assertion = await new SignJWT({ email: "operator@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer.issuer)
      .setAudience("machinectl-test")
      .setSubject("access-user")
      .setExpirationTime(expiresAt)
      .sign(issuer.privateKey);
    const identity = await verifyAccess(new Request(LOOPBACK, { headers: { "Cf-Access-Jwt-Assertion": assertion } }), {
      CF_ACCESS_ISS: issuer.issuer,
      CF_ACCESS_AUD: "machinectl-test",
      MACHINECTL_ALLOWED_EMAILS: "operator@example.com",
    });
    assert.equal(identity.expiresAt, expiresAt);
  } finally {
    await issuer.close();
  }
});

test("verifyAccess provides a bounded expiry for development identities", async () => {
  const before = Math.floor(Date.now() / 1000);
  const identity = await verifyAccess(new Request(LOOPBACK), devEnv());
  const after = Math.floor(Date.now() / 1000);
  assert.equal(identity.expiresAt >= before + 3599, true);
  assert.equal(identity.expiresAt <= after + 3600, true);
});

test("Access expiry comparison distinguishes past and future timestamps", () => {
  const now = Date.now();
  assert.equal(hasExpiredAccess(Math.floor(now / 1000) - 1, now), true);
  assert.equal(hasExpiredAccess(Math.floor(now / 1000) + 1, now), false);
});
