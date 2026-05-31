import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessIdentity {
  email: string;
  sub: string;
}

type AuthBindings = {
  CF_ACCESS_AUD: string;
  CF_ACCESS_ISS: string;
};

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksIssuer: string | undefined;

function keySet(issuer: string) {
  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksIssuer = issuer;
  }
  return jwks;
}

export async function verifyAccess(request: Request, env: AuthBindings): Promise<AccessIdentity> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new Error("Missing Cloudflare Access JWT assertion");
  const { payload } = await jwtVerify(assertion, keySet(env.CF_ACCESS_ISS), {
    issuer: env.CF_ACCESS_ISS,
    audience: env.CF_ACCESS_AUD,
  });
  if (typeof payload.email !== "string" || typeof payload.sub !== "string") {
    throw new Error("Cloudflare Access JWT lacks required identity claims");
  }
  return { email: payload.email.toLowerCase(), sub: payload.sub };
}

export function accessMiddleware(): MiddlewareHandler<{
  Bindings: AuthBindings;
  Variables: { identity: AccessIdentity };
}> {
  return async (c, next) => {
    try {
      c.set("identity", await verifyAccess(c.req.raw, c.env));
      await next();
    } catch (error) {
      return c.json({ error: "unauthorized", message: error instanceof Error ? error.message : String(error) }, 401);
    }
  };
}
