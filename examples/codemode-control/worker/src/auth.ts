import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessIdentity {
  email: string;
  sub: string;
  expiresAt: number;
}

type AuthBindings = {
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ISS?: string;
  MACHINECTL_ENV?: string;
  MACHINECTL_DEV_AUTH?: string;
  MACHINECTL_DEV_EMAIL?: string;
  MACHINECTL_ALLOWED_EMAILS?: string;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksIssuer: string | undefined;

export function hasExpiredAccess(expiresAt: number, now = Date.now()): boolean {
  return now >= expiresAt * 1000;
}

export function assertDeployableConfig(env: AuthBindings): void {
  if (env.MACHINECTL_DEV_AUTH !== "1") return;
  if (env.MACHINECTL_ENV !== "development") {
    throw new Error("MACHINECTL_DEV_AUTH=1 requires MACHINECTL_ENV=\"development\". Remove the bypass before deploying this configuration.");
  }
  if (env.CF_ACCESS_ISS || env.CF_ACCESS_AUD) {
    throw new Error("MACHINECTL_DEV_AUTH=1 cannot be combined with CF_ACCESS_ISS or CF_ACCESS_AUD. A configuration holding both a bypass and real Cloudflare Access credentials is a deployment accident.");
  }
}

function keySet(issuer: string) {
  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksIssuer = issuer;
  }
  return jwks;
}

export async function verifyAccess(request: Request, env: AuthBindings): Promise<AccessIdentity> {
  if (env.MACHINECTL_DEV_AUTH === "1") {
    if (env.MACHINECTL_ENV !== "development") throw new Error("development authentication bypass refused outside local development configuration");
    const host = new URL(request.url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") throw new Error("development authentication bypass refused on a non-loopback host");
    const email = (env.MACHINECTL_DEV_EMAIL ?? "dev@machinectl.local").toLowerCase();
    return { email, sub: `dev:${email}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  }
  if (!env.CF_ACCESS_ISS || !env.CF_ACCESS_AUD) throw new Error("Cloudflare Access is not configured");
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new Error("Missing Cloudflare Access JWT assertion");
  const { payload } = await jwtVerify(assertion, keySet(env.CF_ACCESS_ISS), {
    issuer: env.CF_ACCESS_ISS,
    audience: env.CF_ACCESS_AUD,
  });
  if (typeof payload.email !== "string" || typeof payload.sub !== "string" || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Cloudflare Access JWT lacks required identity claims");
  }
  const email = payload.email.toLowerCase();
  const allowed = (env.MACHINECTL_ALLOWED_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) throw new Error("MACHINECTL_ALLOWED_EMAILS must explicitly list operator identities");
  if (!allowed.includes(email)) throw new Error("verified identity is not an allowed machinectl operator");
  return { email, sub: payload.sub, expiresAt: payload.exp };
}

export function accessMiddleware(): MiddlewareHandler<{
  Bindings: AuthBindings;
  Variables: { identity: AccessIdentity };
}> {
  return async (c, next) => {
    try {
      assertDeployableConfig(c.env);
      c.set("identity", await verifyAccess(c.req.raw, c.env));
      await next();
    } catch (error) {
      return c.json({ error: "unauthorized", message: error instanceof Error ? error.message : String(error) }, 401);
    }
  };
}
